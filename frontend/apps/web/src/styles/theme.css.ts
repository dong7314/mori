import {
  createThemeContract,
  createTheme,
  globalStyle,
} from "@vanilla-extract/css";
import { lightColors, darkColors } from "@mori/design-tokens";
import { lightElevation, darkElevation } from "@mori/design-tokens";

export const vars = createThemeContract({
  color: {
    background: null,
    surface: null,
    textPrimary: null,
    textSecondary: null,
    border: null,
    accent: null,
  },
  elevation: {
    none: null,
    sm: null,
    md: null,
    lg: null,
    xl: null,
  },
});

export const lightTheme = createTheme(vars, {
  color: lightColors,
  elevation: lightElevation,
});

export const darkTheme = createTheme(vars, {
  color: darkColors,
  elevation: darkElevation,
});

// 생성된 테마 클래스에 브라우저 기본 UI의 색상 모드
globalStyle(`.${lightTheme}`, {
  colorScheme: "light",
});

globalStyle(`.${darkTheme}`, {
  colorScheme: "dark",
});
