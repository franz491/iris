export type ReauthPrompt = () => Promise<boolean>;
export async function withRecentAuth<T>(operation: () => Promise<T>, prompt: ReauthPrompt): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if ((error as { code?: string })?.code !== "recent_auth_required") throw error;
    if (!(await prompt())) throw error;
    return operation();
  }
}
