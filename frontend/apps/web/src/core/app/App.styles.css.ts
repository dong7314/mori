import { style } from "@vanilla-extract/css";
import {
  spacing,
  radius,
  typography,
  motionDuration,
} from "@mori/design-tokens";
import { vars } from "../../styles/theme.css";
import { toRem } from "../util/common";

export const page = style({
  minHeight: "100svh",
  padding: spacing.xl,
  backgroundColor: vars.color.background,
  color: vars.color.textPrimary,
});

export const card = style({
  maxWidth: "480px",
  margin: "0 auto",
  padding: spacing.xl,
  border: `1px solid ${vars.color.border}`,
  borderRadius: radius.md,
  backgroundColor: vars.color.surface,
  boxShadow: vars.elevation.sm,
});

export const title = style({
  margin: spacing.none,
  marginBottom: spacing.lg,
  color: vars.color.accent,
  fontSize: toRem(typography.fontSize.pageTitle),
  lineHeight: 1.3,
});

export const description = style({
  color: vars.color.textSecondary,
});

export const toggle = style({
  position: "relative",
  isolation: "isolate",
  marginTop: spacing.lg,
  minHeight: "44px",
  paddingBlock: spacing.sm,
  paddingInline: spacing.lg,
  border: "1px solid transparent",
  borderRadius: radius.sm,
  backgroundColor: "transparent",
  color: vars.color.accent,
  cursor: "pointer",

  "::before": {
    content: '""',
    position: "absolute",
    inset: "-1px",
    zIndex: -1,
    pointerEvents: "none",

    border: "1px solid currentColor",
    borderRadius: "inherit",
    backgroundColor: vars.color.surface,
  },

  ":focus-visible": {
    outline: `2px solid ${vars.color.accent}`,
    outlineOffset: spacing.xs,
  },

  "@media": {
    "(prefers-reduced-motion: no-preference)": {
      selectors: {
        "&::before": {
          transition: `transform ${motionDuration.feedback}ms ease-out`,
        },
        "&:active::before": {
          transform: "scale(0.98)",
        },
      },
    },
  },
});
