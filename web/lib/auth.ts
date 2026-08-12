import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth/minimal";
import { db } from "./db";
import * as schema from "./db/schema/auth";

export const auth = betterAuth({
  appName: "Bonte CRM Assistant",
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
  }),
  emailAndPassword: {
    enabled: true,
  },
});
