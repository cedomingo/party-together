// Platform-core "state screen" (SPEC.md §11: "clean loading/empty/error
// states for room-not-found, room-full, room-already-started"). One shared
// shell for every non-happy-path a room page can land on, so they look and
// behave consistently instead of each being a one-off block of JSX:
//   - `kind="loading"` -> role="status" + aria-busy, for the initial fetch
//   - `kind="info"`    -> role="status", aria-live="polite" — a state that
//     isn't an error (room's full, already started, etc.), just something
//     the visitor should be told about calmly
//   - `kind="error"`   -> role="alert" — something actually went wrong
//
// Game-agnostic on purpose: this lives in /app/components alongside
// CreateRoomForm/JoinRoomForm, not inside a game module, and takes no
// game-specific props. RoomClient.tsx (platform core) is the only expected
// caller, but nothing here assumes that.

import Link from "next/link";
import type { ReactNode } from "react";

interface StatusScreenProps {
  kind: "loading" | "info" | "error";
  title: string;
  children?: ReactNode;
  /** Show a "Back to home" link. Defaults to true for info/error, false for loading. */
  showHomeLink?: boolean;
}

export function StatusScreen({ kind, title, children, showHomeLink }: StatusScreenProps) {
  const role = kind === "error" ? "alert" : "status";
  const shouldShowHomeLink = showHomeLink ?? kind !== "loading";

  return (
    <main className="page" id="main-content">
      <div
        className={`state-screen state-screen-${kind}`}
        role={role}
        aria-live={kind === "loading" ? undefined : "polite"}
        aria-busy={kind === "loading" ? "true" : undefined}
      >
        {kind === "loading" && (
          <span className="state-spinner" aria-hidden="true" />
        )}
        <h1>{title}</h1>
        {children && <div className="state-screen-body">{children}</div>}
      </div>
      {shouldShowHomeLink && (
        <p className="state-screen-actions">
          <Link href="/">Back to home</Link>
        </p>
      )}
    </main>
  );
}
