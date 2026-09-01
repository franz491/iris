// src-tauri/src/audio.rs — local audio capture/playback for the AI.
//
// cpal for device access, hound for WAV encode/decode. Semantics follow the
// audio provider spec (providers/installed/audio.md):
//   tool_audio_devices            -> refresh_devices: Vec<DeviceInfo>
//   tool_audio_play(wav_b64, dev) -> stream_audio: play a WAV, blocking until done
//   tool_audio_read(seconds, dev) -> read_audio: record N seconds, WAV as base64
//
// Device selection is by (case-insensitive substring of the) device name;
// None = system default.
use base64::Engine;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SizedSample};
use std::io::Cursor;

const MAX_WAV_BYTES: usize = 24 * 1024 * 1024;
const MAX_WAV_SAMPLES: usize = 8 * 1024 * 1024;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};

static AUDIO_OPERATION: Mutex<Option<(u64, Arc<AtomicBool>)>> = Mutex::new(None);
static NEXT_AUDIO_ID: AtomicU64 = AtomicU64::new(1);

struct AudioOperationGuard;
impl AudioOperationGuard {
    fn acquire() -> Result<(Self, u64, Arc<AtomicBool>), String> {
        let mut busy = AUDIO_OPERATION
            .lock()
            .map_err(|_| "audio operation state poisoned".to_string())?;
        if busy.is_some() {
            return Err("another audio operation is already in progress".into());
        }
        let id = NEXT_AUDIO_ID.fetch_add(1, Ordering::Relaxed);
        let cancelled = Arc::new(AtomicBool::new(false));
        *busy = Some((id, cancelled.clone()));
        Ok((Self, id, cancelled))
    }
}
impl Drop for AudioOperationGuard {
    fn drop(&mut self) {
        if let Ok(mut busy) = AUDIO_OPERATION.lock() {
            *busy = None;
        }
    }
}

#[tauri::command]
pub fn cancel_audio_operation(id: u64) -> Result<bool, String> {
    let active = AUDIO_OPERATION
        .lock()
        .map_err(|_| "audio operation state poisoned".to_string())?;
    if let Some((active_id, flag)) = active.as_ref() {
        if *active_id == id {
            flag.store(true, Ordering::Release);
            return Ok(true);
        }
    }
    Ok(false)
}

/// Returns the ID of the currently active operation, if any.
#[tauri::command]
pub fn active_audio_operation_id() -> Result<Option<u64>, String> {
    let active = AUDIO_OPERATION
        .lock()
        .map_err(|_| "audio operation state poisoned".to_string())?;
    Ok(active.as_ref().map(|(id, _)| *id))
}

#[derive(serde::Serialize)]
pub struct DeviceInfo {
    pub name: String,
    /// true = input (microphone), false = output (speaker)
    pub input: bool,
}

fn host() -> cpal::Host {
    cpal::default_host()
}

fn find_device(name: Option<&str>, input: bool) -> Result<cpal::Device, String> {
    let wanted = name.map(|n| n.to_lowercase());
    let iter: Vec<cpal::Device> = if input {
        host().input_devices().map_err(|e| e.to_string())?.collect()
    } else {
        host()
            .output_devices()
            .map_err(|e| e.to_string())?
            .collect()
    };
    match wanted {
        None => {
            let d = if input {
                host().default_input_device()
            } else {
                host().default_output_device()
            };
            d.ok_or_else(|| "no default device".to_string())
        }
        Some(w) => {
            let named: Vec<(cpal::Device, String)> = iter
                .into_iter()
                .filter_map(|d| d.name().ok().map(|name| (d, name)))
                .collect();
            let names: Vec<String> = named.iter().map(|(_, name)| name.clone()).collect();
            let selected = select_device_index(&names, &w)?;
            named
                .into_iter()
                .nth(selected)
                .map(|(device, _)| device)
                .ok_or_else(|| "selected audio device disappeared".to_string())
        }
    }
}

fn select_device_index(names: &[String], wanted: &str) -> Result<usize, String> {
    let wanted = wanted.to_lowercase();
    let exact: Vec<usize> = names
        .iter()
        .enumerate()
        .filter(|(_, name)| name.to_lowercase() == wanted)
        .map(|(i, _)| i)
        .collect();
    if exact.len() == 1 {
        return Ok(exact[0]);
    }
    let matches: Vec<usize> = names
        .iter()
        .enumerate()
        .filter(|(_, name)| name.to_lowercase().contains(&wanted))
        .map(|(i, _)| i)
        .collect();
    match matches.len() {
        1 => Ok(matches[0]),
        0 => Err(format!("no device matching {:?}", wanted)),
        _ => Err(format!(
            "ambiguous audio device {:?}: {} matches",
            wanted,
            matches.len()
        )),
    }
}

#[tauri::command]
pub fn tool_audio_devices(blacklist: Option<Vec<String>>) -> Result<Vec<DeviceInfo>, String> {
    let blacklisted = |n: &str| {
        blacklist
            .as_ref()
            .map(|bl| {
                bl.iter()
                    .any(|b| n.to_lowercase().contains(&b.to_lowercase()))
            })
            .unwrap_or(false)
    };
    let mut out = vec![];
    for input in [true, false] {
        let iter: Vec<cpal::Device> = if input {
            host().input_devices().map_err(|e| e.to_string())?.collect()
        } else {
            host()
                .output_devices()
                .map_err(|e| e.to_string())?
                .collect()
        };
        for d in iter {
            if let Ok(name) = d.name() {
                if !blacklisted(&name) {
                    out.push(DeviceInfo { name, input });
                }
            }
        }
    }
    Ok(out)
}

/// Play a base64-encoded WAV file. Blocks until playback finishes.
/// The device's default output config is used; sample data is naively
/// resampled (repeat/skip) when rates differ — fine for speech.
pub fn play_wav(
    samples: Vec<f32>,
    wav_rate: u32,
    wav_channels: u16,
    device_name: Option<String>,
) -> Result<(), String> {
    let (_operation, _id, cancelled) = AudioOperationGuard::acquire()?;
    let device = find_device(device_name.as_deref(), false)?;
    let supported = device.default_output_config().map_err(|e| e.to_string())?;
    let output_format = output_format(supported.sample_format())?;
    let stream_config: cpal::StreamConfig = supported.clone().into();
    let out_channels = stream_config.channels as usize;
    let ratio = f64::from(stream_config.sample_rate.0) / f64::from(wav_rate);

    let (tx, rx) = mpsc::channel::<String>();
    let idx = Arc::new(AtomicUsize::new(0));
    let idx_cb = idx.clone();
    let input_channels = wav_channels.max(1) as usize;
    let total = samples.len() / input_channels;

    let stream = match output_format {
        OutputFormat::F32 => build_output_stream::<f32, _>(
            &device,
            &stream_config,
            samples.clone(),
            idx_cb.clone(),
            out_channels,
            input_channels,
            total,
            ratio,
            {
                let tx = tx.clone();
                move |e| {
                    let _ = tx.send(format!("stream error: {}", e));
                }
            },
        )?,
        OutputFormat::I16 => build_output_stream::<i16, _>(
            &device,
            &stream_config,
            samples.clone(),
            idx_cb.clone(),
            out_channels,
            input_channels,
            total,
            ratio,
            {
                let tx = tx.clone();
                move |e| {
                    let _ = tx.send(format!("stream error: {}", e));
                }
            },
        )?,
        OutputFormat::U16 => build_output_stream::<u16, _>(
            &device,
            &stream_config,
            samples,
            idx_cb,
            out_channels,
            input_channels,
            total,
            ratio,
            {
                let tx = tx.clone();
                move |e| {
                    let _ = tx.send(format!("stream error: {}", e));
                }
            },
        )?,
    };
    stream.play().map_err(|e| e.to_string())?;

    // wait until all samples were handed to the device
    loop {
        if cancelled.load(Ordering::Acquire) {
            return Err("audio operation cancelled".into());
        }
        let i = idx.load(Ordering::Relaxed);
        if i as f64 >= total as f64 / ratio {
            break;
        }
        if let Ok(e) = rx.try_recv() {
            return Err(e);
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let _ = tx.send(String::new()); // release the sender
    drop(stream);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn build_output_stream<T, E>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    samples: Vec<f32>,
    index: Arc<AtomicUsize>,
    out_channels: usize,
    input_channels: usize,
    total: usize,
    ratio: f64,
    err_fn: E,
) -> Result<cpal::Stream, String>
where
    T: SizedSample + FromSample<f32>,
    E: FnMut(cpal::StreamError) + Send + 'static,
{
    device
        .build_output_stream(
            config,
            move |out: &mut [T], _| {
                let mut i = index.load(Ordering::Relaxed);
                for frame in out.chunks_mut(out_channels.max(1)) {
                    if i >= total {
                        for sample in frame.iter_mut() {
                            *sample = T::from_sample(0.0);
                        }
                        continue;
                    }
                    let mapped = map_frame(
                        &samples,
                        input_channels,
                        out_channels,
                        (i as f64 * ratio) as usize,
                    );
                    for (sample, value) in frame.iter_mut().zip(mapped) {
                        *sample = T::from_sample(value);
                    }
                    i += 1;
                }
                index.store(i, Ordering::Relaxed);
            },
            err_fn,
            None,
        )
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn tool_audio_play(wav_base64: String, device: Option<String>) -> Result<(), String> {
    if wav_base64.len() > (MAX_WAV_BYTES * 4 / 3) + 8 {
        return Err(format!("wav input exceeds {} bytes", MAX_WAV_BYTES));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(wav_base64.trim())
        .map_err(|e| format!("invalid base64: {}", e))?;
    let (samples, rate, channels) = decode_wav(&bytes)?;
    play_wav(samples, rate, channels, device)
}

fn map_frame(
    samples: &[f32],
    input_channels: usize,
    output_channels: usize,
    frame: usize,
) -> Vec<f32> {
    let start = frame.saturating_mul(input_channels);
    let source = samples
        .get(start..start.saturating_add(input_channels))
        .unwrap_or(&[]);
    let finite = |value: f32| {
        if value.is_finite() {
            value.clamp(-1.0, 1.0)
        } else {
            0.0
        }
    };
    (0..output_channels.max(1))
        .map(|channel| {
            if source.is_empty() {
                0.0
            } else if input_channels == 1 {
                finite(source[0])
            } else if output_channels == 1 {
                finite(source.iter().copied().sum::<f32>() / source.len() as f32)
            } else {
                finite(source[channel.min(source.len() - 1)])
            }
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OutputFormat {
    F32,
    I16,
    U16,
}

fn output_format(format: cpal::SampleFormat) -> Result<OutputFormat, String> {
    match format {
        cpal::SampleFormat::F32 => Ok(OutputFormat::F32),
        cpal::SampleFormat::I16 => Ok(OutputFormat::I16),
        cpal::SampleFormat::U16 => Ok(OutputFormat::U16),
        other => Err(format!("unsupported output sample format: {:?}", other)),
    }
}

#[cfg(test)]
fn convert_output(value: f32, format: OutputFormat) -> f32 {
    let value = if value.is_finite() {
        value.clamp(-1.0, 1.0)
    } else {
        0.0
    };
    match format {
        OutputFormat::F32 => value,
        OutputFormat::I16 => (value * 32767.0).round() / 32767.0,
        OutputFormat::U16 => ((value * 0.5 + 0.5) * 65535.0).round() / 65535.0,
    }
}

fn decode_wav(bytes: &[u8]) -> Result<(Vec<f32>, u32, u16), String> {
    if bytes.len() > MAX_WAV_BYTES {
        return Err(format!("wav exceeds {} bytes", MAX_WAV_BYTES));
    }
    let mut reader =
        hound::WavReader::new(Cursor::new(bytes)).map_err(|e| format!("invalid wav: {}", e))?;
    let spec = reader.spec();
    if spec.sample_rate == 0 || spec.channels == 0 {
        return Err("invalid wav: zero rate or channels".into());
    }
    let count = reader.duration() as usize;
    if count > MAX_WAV_SAMPLES {
        return Err(format!("wav exceeds {} samples", MAX_WAV_SAMPLES));
    }
    let mut samples = Vec::with_capacity(count);
    match spec.sample_format {
        hound::SampleFormat::Float => {
            for sample in reader.samples::<f32>() {
                let value = sample.map_err(|e| format!("invalid wav sample: {}", e))?;
                if !value.is_finite() {
                    return Err("invalid wav sample: non-finite float".into());
                }
                samples.push(value);
            }
        }
        hound::SampleFormat::Int => match spec.bits_per_sample {
            16 => {
                for sample in reader.samples::<i16>() {
                    samples.push(
                        sample.map_err(|e| format!("invalid wav sample: {}", e))? as f32 / 32768.0,
                    );
                }
            }
            32 => {
                for sample in reader.samples::<i32>() {
                    samples.push(
                        sample.map_err(|e| format!("invalid wav sample: {}", e))? as f32
                            / 2147483648.0,
                    );
                }
            }
            b => return Err(format!("unsupported bits per sample: {}", b)),
        },
    }
    if samples.len() > MAX_WAV_SAMPLES {
        return Err(format!("wav exceeds {} samples", MAX_WAV_SAMPLES));
    }
    Ok((samples, spec.sample_rate, spec.channels))
}

/// Record `seconds` of audio from an input device; returns base64 WAV (16-bit mono).
#[tauri::command]
pub fn tool_audio_read(seconds: f32, device: Option<String>) -> Result<String, String> {
    let (_operation, _id, cancelled) = AudioOperationGuard::acquire()?;
    let seconds = seconds.clamp(0.1, 300.0);
    let device = find_device(device.as_deref(), true)?;
    let supported = device.default_input_config().map_err(|e| e.to_string())?;
    let input_format = supported.sample_format();
    let sample_rate = supported.sample_rate().0;
    let channels = supported.channels() as usize;
    let stream_config: cpal::StreamConfig = supported.into();

    let target = (sample_rate as f32 * channels as f32 * seconds) as usize;
    let collected: Arc<Mutex<Vec<f32>>> =
        Arc::new(Mutex::new(Vec::with_capacity(target.min(MAX_WAV_SAMPLES))));
    let (tx, rx) = mpsc::channel::<String>();
    let stream = match input_format {
        cpal::SampleFormat::F32 => {
            build_input_stream::<f32, _>(&device, &stream_config, collected.clone(), target, {
                let tx = tx.clone();
                move |e| {
                    let _ = tx.send(format!("stream error: {}", e));
                }
            })?
        }
        cpal::SampleFormat::I16 => {
            build_input_stream::<i16, _>(&device, &stream_config, collected.clone(), target, {
                let tx = tx.clone();
                move |e| {
                    let _ = tx.send(format!("stream error: {}", e));
                }
            })?
        }
        cpal::SampleFormat::U16 => {
            build_input_stream::<u16, _>(&device, &stream_config, collected.clone(), target, {
                let tx = tx.clone();
                move |e| {
                    let _ = tx.send(format!("stream error: {}", e));
                }
            })?
        }
        other => return Err(format!("unsupported input sample format: {:?}", other)),
    };
    stream.play().map_err(|e| e.to_string())?;

    loop {
        if cancelled.load(Ordering::Acquire) {
            return Err("audio operation cancelled".into());
        }
        let len = collected.lock().map(|v| v.len()).unwrap_or(target + 1);
        if len >= target {
            break;
        }
        if let Ok(e) = rx.try_recv() {
            return Err(e);
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    // downmix to mono + convert to i16
    let data = collected.lock().map_err(|_| "lock poisoned")?;
    let mono: Vec<i16> = data
        .chunks(channels.max(1))
        .map(|frame| {
            let avg = frame.iter().sum::<f32>() / channels as f32;
            (avg.clamp(-1.0, 1.0) * 32767.0) as i16
        })
        .collect();

    let mut buf = Cursor::new(Vec::new());
    {
        let mut writer = hound::WavWriter::new(
            &mut buf,
            hound::WavSpec {
                sample_format: hound::SampleFormat::Int,
                sample_rate,
                bits_per_sample: 16,
                channels: 1,
            },
        )
        .map_err(|e| e.to_string())?;
        for s in mono {
            writer.write_sample(s).map_err(|e| e.to_string())?;
        }
        writer.finalize().map_err(|e| e.to_string())?;
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(buf.into_inner()))
}

#[allow(clippy::too_many_arguments)]
fn build_input_stream<T, E>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    collected: Arc<Mutex<Vec<f32>>>,
    limit: usize,
    err_fn: E,
) -> Result<cpal::Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
    E: FnMut(cpal::StreamError) + Send + 'static,
{
    device
        .build_input_stream(
            config,
            move |data: &[T], _| {
                if let Ok(mut values) = collected.lock() {
                    let remaining = limit.saturating_sub(values.len());
                    values.extend(data.iter().take(remaining).map(|sample| {
                        let value = f32::from_sample(*sample);
                        if value.is_finite() {
                            value.clamp(-1.0, 1.0)
                        } else {
                            0.0
                        }
                    }));
                }
            },
            err_fn,
            None,
        )
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    static AUDIO_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn wav(samples: &[i16]) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        let mut writer = hound::WavWriter::new(
            &mut out,
            hound::WavSpec {
                channels: 1,
                sample_rate: 16_000,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .unwrap();
        for sample in samples {
            writer.write_sample(*sample).unwrap();
        }
        writer.finalize().unwrap();
        out.into_inner()
    }

    #[test]
    fn decoder_rejects_oversized_sample_count() {
        let bytes = wav(&vec![0; MAX_WAV_SAMPLES + 1]);
        assert!(decode_wav(&bytes).unwrap_err().contains("samples"));
    }

    #[test]
    fn decoder_reports_corrupt_wav_samples() {
        let mut bytes = wav(&[1]);
        bytes.truncate(bytes.len() - 1);
        assert!(decode_wav(&bytes).unwrap_err().contains("invalid wav"));
    }

    #[test]
    fn channel_mapping_is_bounded_and_clipped() {
        assert_eq!(map_frame(&[2.0, -2.0], 2, 1, 0), vec![0.0]);
        assert_eq!(map_frame(&[f32::NAN], 1, 2, 0), vec![0.0, 0.0]);
        assert_eq!(map_frame(&[0.25], 1, 2, 99), vec![0.0, 0.0]);
    }

    #[test]
    fn output_formats_and_conversion_are_explicit() {
        assert_eq!(
            output_format(cpal::SampleFormat::I16),
            Ok(OutputFormat::I16)
        );
        assert_eq!(convert_output(f32::NAN, OutputFormat::F32), 0.0);
        assert!((convert_output(-1.0, OutputFormat::U16) - 0.0).abs() < f32::EPSILON);
        assert!(output_format(cpal::SampleFormat::I64).is_err());
    }

    #[test]
    fn audio_operation_guard_conflicts_and_releases() {
        let _test_lock = AUDIO_TEST_LOCK.lock().unwrap();
        let first = AudioOperationGuard::acquire().unwrap();
        assert!(AudioOperationGuard::acquire().is_err());
        drop(first);
        assert!(AudioOperationGuard::acquire().is_ok());
    }

    #[test]
    fn audio_operation_guard_releases_on_scope_exit() {
        let _test_lock = AUDIO_TEST_LOCK.lock().unwrap();
        {
            let _guard = AudioOperationGuard::acquire().unwrap();
        }
        assert!(AudioOperationGuard::acquire().is_ok());
    }

    #[test]
    fn active_id_is_visible_only_while_operation_is_active() {
        let _test_lock = AUDIO_TEST_LOCK.lock().unwrap();
        assert_eq!(active_audio_operation_id().unwrap(), None);
        let (guard, id, _) = AudioOperationGuard::acquire().unwrap();
        assert_eq!(active_audio_operation_id().unwrap(), Some(id));
        drop(guard);
        assert_eq!(active_audio_operation_id().unwrap(), None);
    }

    #[test]
    fn stale_id_cannot_cancel_a_later_operation() {
        let _test_lock = AUDIO_TEST_LOCK.lock().unwrap();
        let (first, old_id, _) = AudioOperationGuard::acquire().unwrap();
        drop(first);
        let (second, new_id, flag) = AudioOperationGuard::acquire().unwrap();
        assert!(!cancel_audio_operation(old_id).unwrap());
        assert!(!flag.load(Ordering::Acquire));
        assert!(cancel_audio_operation(new_id).unwrap());
        assert!(flag.load(Ordering::Acquire));
        drop(second);
        assert!(!cancel_audio_operation(new_id).unwrap());
    }

    #[test]
    fn device_selection_is_exact_then_unique_substring() {
        let names = vec!["USB Microphone".into(), "Studio USB Microphone".into()];
        assert_eq!(select_device_index(&names, "usb microphone").unwrap(), 0);
        assert_eq!(select_device_index(&names, "studio").unwrap(), 1);
        assert!(select_device_index(&names, "MICROPHONE")
            .unwrap_err()
            .contains("ambiguous"));
    }

    #[test]
    fn device_selection_reports_missing() {
        let names = vec!["Speakers".into()];
        assert!(select_device_index(&names, "headphones")
            .unwrap_err()
            .contains("no device"));
    }
}
