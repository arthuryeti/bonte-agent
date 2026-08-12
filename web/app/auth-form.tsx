"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { authClient } from "../lib/auth-client";

interface AuthFormProps {
  mode: "login" | "signup";
}

export function AuthForm({ mode }: AuthFormProps) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isSignup = mode === "signup";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setIsSubmitting(true);

    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const name = String(form.get("name") ?? "").trim();

    try {
      const result = isSignup
        ? await authClient.signUp.email({ name, email, password })
        : await authClient.signIn.email({ email, password });

      if (result.error) {
        setError(result.error.message || "Authentication failed. Please try again.");
        return;
      }

      router.replace("/");
      router.refresh();
    } catch {
      setError("Authentication is temporarily unavailable. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-card" aria-labelledby="auth-title">
        <div className="auth-brand">
          <span className="welcome-mark" aria-hidden="true">B</span>
          <div>
            <p className="title">CRM Assistant</p>
            <p>Bonte workspace</p>
          </div>
        </div>

        <div className="auth-copy">
          <p className="auth-eyebrow">{isSignup ? "Create your account" : "Welcome back"}</p>
          <h1 id="auth-title">{isSignup ? "Get started" : "Sign in"}</h1>
          <p>
            {isSignup
              ? "Create an account to keep your CRM conversations private."
              : "Use your email and password to continue to your workspace."}
          </p>
        </div>

        <form className="auth-form" onSubmit={handleSubmit}>
          {isSignup ? (
            <label>
              <span>Name</span>
              <input
                name="name"
                type="text"
                autoComplete="name"
                placeholder="Your name"
                required
                autoFocus
                disabled={isSubmitting}
              />
            </label>
          ) : null}

          <label>
            <span>Email</span>
            <input
              name="email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              required
              autoFocus={!isSignup}
              disabled={isSubmitting}
            />
          </label>

          <label>
            <span>Password</span>
            <input
              name="password"
              type="password"
              autoComplete={isSignup ? "new-password" : "current-password"}
              placeholder="At least 8 characters"
              minLength={8}
              required
              disabled={isSubmitting}
            />
          </label>

          {error ? <p className="auth-error" role="alert">{error}</p> : null}

          <button type="submit" disabled={isSubmitting} aria-busy={isSubmitting}>
            {isSubmitting
              ? isSignup ? "Creating account…" : "Signing in…"
              : isSignup ? "Create account" : "Sign in"}
          </button>
        </form>

        <p className="auth-switch">
          {isSignup ? "Already have an account?" : "New to Bonte?"}{" "}
          <Link href={isSignup ? "/login" : "/signup"}>
            {isSignup ? "Sign in" : "Create an account"}
          </Link>
        </p>
      </section>
    </main>
  );
}
