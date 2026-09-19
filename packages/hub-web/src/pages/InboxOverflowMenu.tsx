import { useEffect, useRef, type ReactNode } from "react";
import type { CapabilityStatus } from "../api/types";
import { Button } from "../components/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../components/primitives/dropdown-menu";
import styles from "../styles/inbox-overflow-menu.module.css";

export interface InboxOverflowAction {
  capability: CapabilityStatus;
  label: string;
  onSelect(trigger: HTMLButtonElement): void;
  variant?: "default" | "destructive";
}

export interface InboxOverflowMenuProps {
  actions: InboxOverflowAction[];
  ariaLabel: string;
  focusFirstItem: boolean;
  groupLabel: string;
  triggerContent: ReactNode;
}

export default function InboxOverflowMenu({
  actions,
  ariaLabel,
  focusFirstItem,
  groupLabel,
  triggerContent,
}: InboxOverflowMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusFirstItem) return;
    let cancelled = false;
    queueMicrotask(() => queueMicrotask(() => {
      if (cancelled) return;
      contentRef.current
        ?.querySelector<HTMLElement>('[role="menuitem"]:not([data-disabled])')
        ?.focus({ preventScroll: true });
    }));
    return () => { cancelled = true; };
  }, [focusFirstItem]);
  return (
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger
        aria-label={ariaLabel}
        ref={triggerRef}
        render={<Button size="sm" type="button" variant="outline" />}
      >
        {triggerContent}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={styles.menu} ref={contentRef}>
        <DropdownMenuGroup>
          <DropdownMenuLabel>{groupLabel}</DropdownMenuLabel>
          {actions.map((action) => {
            const unavailable = action.capability.availability === "unavailable";
            return (
              <DropdownMenuItem
                disabled={unavailable}
                key={action.label}
                onClick={() => {
                  if (triggerRef.current) action.onSelect(triggerRef.current);
                }}
                variant={action.variant}
              >
                <span className={styles.actionCopy}>
                  <span>{action.label}</span>
                  {unavailable ? <small>{action.capability.reason}</small> : null}
                </span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
