"use client";

import { AuiIf, useAuiState, ThreadPrimitive } from "@assistant-ui/react";
import { Button } from "@/components/ui/button";
import type { FC } from "react";

export const ThreadSuggestions: FC<{ preview?: boolean }> = ({ preview = false }) => {
  const suggestions = useAuiState((s) => s.thread.suggestions);
  const buttons = suggestions.map((suggestion) => (
    <ThreadPrimitive.Suggestion
      key={suggestion.prompt}
      prompt={suggestion.prompt}
      clearComposer={false}
      asChild
    >
      <Button
        variant="outline"
        className="h-auto min-h-16 min-w-0 flex-col items-start justify-start gap-1 rounded-xl p-3 text-left whitespace-normal shadow-none"
      >
        <span>{suggestion.title ?? suggestion.prompt}</span>
        {suggestion.label && (
          <span className="text-xs font-normal text-muted-foreground">
            {suggestion.label}
          </span>
        )}
      </Button>
    </ThreadPrimitive.Suggestion>
  ));

  return (
    <div className="aui-thread-workflow-suggestions space-y-3">
      {preview && (
        <div className="grid grid-cols-1 gap-2 min-[380px]:grid-cols-2">
          {buttons.slice(0, 6)}
        </div>
      )}
      <details className="rounded-xl border bg-background p-3">
        <summary className="cursor-pointer rounded-sm text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
          All workflows
        </summary>
        <p className="mt-3 text-xs text-muted-foreground">
          Choose a starting point, add details or documents, then send.
        </p>
        <div className="mt-3 grid max-h-72 grid-cols-1 gap-2 overflow-y-auto p-1 min-[380px]:grid-cols-2">
          {buttons}
        </div>
      </details>
    </div>
  );
};

export const ThreadFollowupSuggestions: FC = () => (
  <AuiIf
    condition={(s) =>
      !s.thread.isEmpty &&
      !s.thread.isRunning &&
      s.thread.suggestions.length > 0
    }
  >
    <ThreadSuggestions />
  </AuiIf>
);
