"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/** True in the browser, false while rendering on the server: AG Grid is drawn on the client only. */
export const useIsClient = () =>
  useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
