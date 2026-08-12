import { headers } from "next/headers";
import { redirect } from "next/navigation";
import ChatPage from "./chat-page";
import { getAuthSession } from "../lib/auth-session";

export default async function HomePage() {
  const session = await getAuthSession(await headers());
  if (!session) redirect("/login");

  return (
    <ChatPage
      user={{
        name: session.user.name,
        email: session.user.email,
      }}
    />
  );
}
