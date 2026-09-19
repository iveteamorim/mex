import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { useHubApi } from "../api/context";
import { hubPageCategory } from "../api/telemetry";

/** Navigation only: query edits, hash changes, polling, and renders stay quiet. */
export function PageViewObserver() {
  const api = useHubApi();
  const { pathname } = useLocation();
  const previousPath = useRef<string | null>(null);
  useEffect(() => {
    if (!api.recordPageView || previousPath.current === pathname) return;
    previousPath.current = pathname;
    void api.recordPageView(hubPageCategory(pathname)).catch(() => undefined);
  }, [api, pathname]);
  return null;
}
