// providers/installed/index.ts — registers all preinstalled providers.
import { registerProviderFactory } from "../../runtime/kernel.js";
import { FilesProvider } from "./files.js";
import { DocsProvider } from "./docs.js";
import { ShellProvider } from "./shell.js";
import { AudioProvider } from "./audio.js";
import { SearchProvider } from "./search.js";
import { MemoryProvider } from "./memory.js";
import { TtsProvider } from "./tts.js";
import { AdminSetupProvider } from "./admin-setup.js";

export function registerInstalledProviders(): void {
  registerProviderFactory("files", () => new FilesProvider());
  registerProviderFactory("docs", () => new DocsProvider());
  registerProviderFactory("shell", () => new ShellProvider());
  registerProviderFactory("audio", () => new AudioProvider());
  registerProviderFactory("search", () => new SearchProvider());
  registerProviderFactory("memory", () => new MemoryProvider());
  registerProviderFactory("tts", () => new TtsProvider());
  registerProviderFactory("admin-setup", () => new AdminSetupProvider());
}

export { FilesProvider, DocsProvider, ShellProvider, AudioProvider, SearchProvider, MemoryProvider, TtsProvider };
