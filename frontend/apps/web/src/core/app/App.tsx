import { useState } from "react";

import type { ThemeMode } from "./type/App.type";

import { darkTheme, lightTheme } from "../../styles/theme.css";
import { page, card, title, toggle, description } from "./App.styles.css";

function App() {
  // 테마 값 초기 세팅
  const [theme, setTheme] = useState<ThemeMode>("light");

  const themeClass = theme === "dark" ? darkTheme : lightTheme;

  return (
    <main className={`${themeClass} ${page}`}>
      <section className={card}>
        <h1 className={title}>Mori 테마 미리보기</h1>
        <p className={description}>
          현재 테마: {theme === "dark" ? "다크" : "라이트"}
        </p>
        <button
          type="button"
          className={toggle}
          onClick={() => {
            setTheme((current) => (current === "light" ? "dark" : "light"));
          }}
        >
          다크 테마
        </button>
      </section>
    </main>
  );
}

export default App;
