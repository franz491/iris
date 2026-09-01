import { setGauge } from "../misc/metrics.js";
type Close = () => void;
const clients = new Set<Close>();
export function registerSse(close: Close): () => void {
  clients.add(close);
  setGauge("sse.active_clients", clients.size);
  return () => {
    clients.delete(close);
    setGauge("sse.active_clients", clients.size);
  };
}
export function closeAllSse(): void {
  for (const close of [...clients]) close();
  clients.clear();
  setGauge("sse.active_clients", 0);
}
export function activeSseCount(): number {
  return clients.size;
}
