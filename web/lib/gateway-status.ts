"use client";
import { useCallback, useEffect, useState } from "react";
import {
  api,
  probeHealth,
  remoteOf,
  type GatewayHealth,
  type Remote,
} from "./api";
import type { HarnessModelView, RuntimeInfo } from "./contracts";

export interface GatewayStatus {
  health: GatewayHealth;
  /** Time of the last completed health probe. */
  checkedAt: number | null;
  runtime: Remote<RuntimeInfo>;
  model: Remote<HarnessModelView>;
  /** Re-read runtime mode and the unified model; failures become `Remote` states, never rejections. */
  reload: () => Promise<void>;
  /** Adopt a fresher unified-model view returned by a save. */
  setModel: (view: HarnessModelView) => void;
}

/**
 * Owns the console's only Gateway health poll: every 5 s while ready, every 3 s otherwise,
 * and immediately when the tab becomes visible. Mode and unified model are re-read each time
 * the Gateway (re)becomes ready, so a restarted Gateway is reflected without a page reload.
 * The poll and its timer stop when the component using the hook unmounts.
 */
export function useGatewayStatus(): GatewayStatus {
  const [health, setHealth] = useState<GatewayHealth>("checking");
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [runtime, setRuntime] = useState<Remote<RuntimeInfo>>({
    state: "loading",
  });
  const [model, setModelState] = useState<Remote<HarnessModelView>>({
    state: "loading",
  });
  const load = useCallback(async (signal?: AbortSignal) => {
    const [info, view] = await Promise.allSettled([
      api.runtimeInfo(signal),
      api.harnessModel(signal),
    ]);
    if (signal?.aborted) return;
    setRuntime(remoteOf(info));
    setModelState(remoteOf(view));
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let previous: GatewayHealth = "checking";
    let busy = false;
    const tick = async () => {
      if (busy || controller.signal.aborted) return;
      busy = true;
      clearTimeout(timer);
      let next: GatewayHealth = previous;
      try {
        next = await probeHealth(controller.signal);
        setHealth(next);
        setCheckedAt(Date.now());
        if (next === "ready" && previous !== "ready")
          await load(controller.signal);
        previous = next;
      } catch (error) {
        // probeHealth reports transport failures as "offline"; only an unmount abort rejects.
        if (controller.signal.aborted) return;
        console.error(error);
      } finally {
        busy = false;
      }
      timer = setTimeout(() => void tick(), next === "ready" ? 5000 : 3000);
    };
    const visible = () => {
      if (document.visibilityState === "visible") void tick();
    };
    void tick();
    document.addEventListener("visibilitychange", visible);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [load]);
  const reload = useCallback(() => load(), [load]);
  const setModel = useCallback(
    (view: HarnessModelView) => setModelState({ state: "ready", value: view }),
    [],
  );
  return { health, checkedAt, runtime, model, reload, setModel };
}
