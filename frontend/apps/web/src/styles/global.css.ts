import { globalFontFace, globalStyle } from "@vanilla-extract/css";
import { toRem } from "../core/util/common";
import { typography } from "@mori/design-tokens";

globalStyle("*, *::before, *::after", {
  boxSizing: "border-box",
});

globalStyle("body", {
  margin: 0,
  fontFamily: '"Pretendard Variable", system-ui, sans-serif',
  fontSize: toRem(typography.fontSize.body),
});

globalStyle("button, input, textarea, select", {
  font: "inherit",
});

globalFontFace("Pretendard Variable", {
  src: 'url("/fonts/PretendardVariable.woff2") format("woff2")',
  fontStyle: "normal",
  fontWeight: "100 900",
  fontDisplay: "swap",
});
