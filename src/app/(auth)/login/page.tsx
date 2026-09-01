"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { AuthShell } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("jordan@example.com");
  const [password, setPassword] = useState("••••••••••");
  const [loading, setLoading] = useState(false);

  function signIn(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    // Mock auth — no backend. Navigate straight into the demo account.
    setTimeout(() => router.push("/app/overview"), 500);
  }

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to your school."
      footer={
        <p className="text-center text-sm text-muted-foreground">
          Don&apos;t have an account?{" "}
          <Link
            href="/signup"
            className="font-medium text-brand hover:underline"
          >
            Get started
          </Link>
        </p>
      }
    >
      <Button
        variant="outline"
        className="w-full"
        size="lg"
        onClick={() => router.push("/app/overview")}
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M12 2v20M2 12h20"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
        Continue with Apple
      </Button>
      <div className="my-6 flex items-center gap-3">
        <div className="h-px flex-1 bg-border" />
        <span className="text-xs text-muted-foreground">or with email</span>
        <div className="h-px flex-1 bg-border" />
      </div>

      <form onSubmit={signIn} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
          />
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">Password</Label>
            <Link
              href="#"
              className="text-xs text-brand hover:underline"
            >
              Forgot password?
            </Link>
          </div>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <Button type="submit" size="lg" className="w-full" disabled={loading}>
          {loading ? "Signing in…" : "Sign in"}
          {!loading && <ArrowRight className="h-4 w-4" />}
        </Button>
      </form>

      <p className="mt-6 rounded-lg bg-secondary/60 p-3 text-center text-xs leading-relaxed text-muted-foreground">
        This is a preview with mock integrations. Use the demo account above —
        no real bank or brokerage is connected.
      </p>
    </AuthShell>
  );
}