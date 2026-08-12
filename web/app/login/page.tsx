import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AuthForm } from "../auth-form";
import { getAuthSession } from "../../lib/auth-session";

export default async function LoginPage() {
  const session = await getAuthSession(await headers());
  if (session) redirect("/");

  return <AuthForm mode="login" />;
}
