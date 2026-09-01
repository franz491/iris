export const HISTORY_WINDOW_SIZE = 120;

export function historyWindow<T>(
  messages: T[],
  expanded: boolean,
  size = HISTORY_WINDOW_SIZE,
): { visible: T[]; hidden: number } {
  if (expanded || messages.length <= size) return { visible: messages, hidden: 0 };
  return { visible: messages.slice(-size), hidden: messages.length - size };
}
