import { defineConfig } from "drizzle-kit";

const connectionString = process.env.POSTGRES_URL ?? process.env.DATABASE_URL ?? "";
if (!connectionString || (!connectionString.startsWith("postgres") && !connectionString.startsWith("postgresql"))) {
  throw new Error("POSTGRES_URL (or DATABASE_URL with a postgresql:// scheme) is required to run drizzle commands");
}

export default defineConfig({
  schema: "./drizzle/schema.ts",
  out: "./drizzle/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: connectionString,
  },
});
