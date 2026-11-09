import { Skeleton } from "./_arena/panels";

/** Shown while a server-rendered page (the Cockpit, the replay, the Arena) is being prepared. */
export default function Loading() {
  return (
    <main className="wrap" id="main" aria-busy="true">
      <p className="muted" role="status">
        Loading the page…
      </p>
      <Skeleton lines={6} />
    </main>
  );
}
