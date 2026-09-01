// runtime/config-schema.ts — drizzle schema for the configuration database.
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const providerConfigs = sqliteTable("provider_configs", {
  name: text("name").primaryKey(),
  activeFunctionalities: text("active_functionalities", { mode: "json" }).$type<string[]>().notNull(),
  additionalSettings: text("additional_settings", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
});
