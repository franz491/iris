import { BaseProvider } from "../base.js";
import type { ProviderConfig } from "../../runtime/types.js";
import type { ProviderDescriptor } from "../types.js";
import { getChatRow, getParticipantsRows } from "../../chat/database.js";
import { isAdminUser } from "../../api/auth.js";
import {
  setupGetOptions,
  setupListSections,
  setupProposePatch,
  setupReadSection,
  setupValidatePatch,
} from "../../admin/setup-tools.js";

// Nested setup values are validated by the typed contract; the descriptor keeps
// the transport boundary intentionally object-shaped without exposing secrets.
const boundedObjectResult = { type: "object" };

export function isAuthorizedAdminSetupChat(
  chatName: string | null | undefined,
  participants: ReadonlyArray<{ role: string; name?: string | null; userId?: string | null }>,
  isAdmin: (userId: string) => boolean = isAdminUser,
): boolean {
  const humans = participants.filter((p) => p.role === "user");
  return (
    chatName === "Iris guided setup" &&
    participants.some((p) => p.role === "ai" && p.name === "Iris Setup") &&
    humans.length === 1 &&
    Boolean(humans[0]?.userId) &&
    isAdmin(humans[0]!.userId!)
  );
}

export class AdminSetupProvider extends BaseProvider {
  readonly providerDescriptor: ProviderDescriptor = {
    name: "admin-setup",
    description: "Constrained, secret-redacted administration proposals for dedicated administrator chats.",
    options: [
      {
        name: "list_sections",
        description: "List configurable sections.",
        kwargsSchema: { type: "object" },
        returnSchema: { type: "array", maxItems: 64, items: { type: "string", maxLength: 128 } },
      },
      {
        name: "read_section",
        description: "Read one redacted configuration section.",
        kwargsSchema: { type: "object", properties: { section: { type: "string" } }, required: ["section"] },
        returnSchema: boundedObjectResult,
      },
      {
        name: "get_options",
        description: "Get schema choices for a section.",
        kwargsSchema: { type: "object", properties: { section: { type: "string" } }, required: ["section"] },
        returnSchema: boundedObjectResult,
      },
      {
        name: "propose_patch",
        description: "Stage a complete configuration snapshot for human review.",
        kwargsSchema: { type: "object", properties: { config: { type: "object" } }, required: ["config"] },
        returnSchema: boundedObjectResult,
      },
      {
        name: "validate_patch",
        description: "Validate and live-test a staged patch.",
        kwargsSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        returnSchema: boundedObjectResult,
      },
    ],
    additionalConfig: { type: "object", properties: {} },
  };
  async setConfig(config: ProviderConfig) {
    this.config = config;
    this.emit("reload");
  }
  async callFunctionality(name: string, kwargs: unknown): Promise<unknown> {
    const input =
      kwargs && typeof kwargs === "object" && !Array.isArray(kwargs) ? (kwargs as Record<string, unknown>) : {};
    const chatId = String(input.chatId ?? "");
    const [chat, participants] = await Promise.all([getChatRow(chatId), getParticipantsRows(chatId)]);
    if (!isAuthorizedAdminSetupChat(chat.name, participants))
      throw new Error("admin setup tools are restricted to an administrator-only guided setup chat");
    const actor = participants.find((p) => p.role === "user")!.userId!;
    switch (name) {
      case "list_sections":
        return setupListSections();
      case "read_section":
        return setupReadSection(String(input.section));
      case "get_options":
        return setupGetOptions(String(input.section));
      case "propose_patch":
        return setupProposePatch(actor, input.config);
      case "validate_patch":
        return setupValidatePatch(actor, String(input.id));
      default:
        throw new Error("unknown admin setup function");
    }
  }
}
