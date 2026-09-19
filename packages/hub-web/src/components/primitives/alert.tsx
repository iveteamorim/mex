import * as React from "react"

import { cn } from "@/lib/utils"
import styles from "./alert.module.css"

type AlertVariant = "default" | "destructive"

function Alert({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & { variant?: AlertVariant }) {
  return (
    <div
      className={cn(styles.alert, className)}
      data-slot="alert"
      data-variant={variant}
      role="alert"
      {...props}
    />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(styles.title, className)}
      data-slot="alert-title"
      {...props}
    />
  )
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(styles.description, className)}
      data-slot="alert-description"
      {...props}
    />
  )
}

function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(styles.action, className)}
      data-slot="alert-action"
      {...props}
    />
  )
}

export { Alert, AlertTitle, AlertDescription, AlertAction }
