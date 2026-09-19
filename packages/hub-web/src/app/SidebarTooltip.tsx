import { useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import styles from "../styles/shell.module.css";

interface TooltipState {
  id: string;
}

interface TooltipPosition {
  left: number;
  top: number;
}

export function SidebarTooltip({
  children,
  content,
}: {
  children: ReactNode | ((state: TooltipState) => ReactNode);
  content: string;
}) {
  const id = useId();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState<TooltipPosition | null>(null);

  function open() {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const box = anchor.getBoundingClientRect();
    setPosition({
      left: box.right + 8,
      top: Math.max(8, Math.min(box.top, window.innerHeight - 224)),
    });
  }

  return (
    <span
      className={styles.tooltipAnchor}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPosition(null);
      }}
      onFocus={open}
      onKeyDown={(event) => {
        if (event.key === "Escape") setPosition(null);
      }}
      onMouseEnter={open}
      onMouseLeave={() => {
        const focusRemains = anchorRef.current?.contains(document.activeElement);
        if (!focusRemains) setPosition(null);
      }}
      ref={anchorRef}
    >
      {typeof children === "function" ? children({ id }) : children}
      {position && typeof document !== "undefined" ? createPortal(
        <div
          className={styles.sidebarTooltip}
          id={id}
          role="tooltip"
          style={position}
        >
          {content}
        </div>,
        document.body,
      ) : null}
    </span>
  );
}
