import { useEffect, useState } from "react";
import { Moon, Sun } from "./Icons";

type Theme = "light" | "dark";
const THEME_KEY = "coderoom.theme";
const darkQuery = () => window.matchMedia("(prefers-color-scheme: dark)");

/** The theme in force: the one picked here, else the system's. index.html applies a saved pick before paint. */
function currentTheme(): Theme {
  const picked = document.documentElement.dataset.theme;
  if (picked === "light" || picked === "dark") return picked;
  return darkQuery().matches ? "dark" : "light";
}

/** Switches between light and dark, remembering the choice on this device. */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>(currentTheme);

  // Follow the system while nothing has been picked.
  useEffect(() => {
    const query = darkQuery();
    const onChange = () => setTheme(currentTheme());
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // The switch still works for this visit.
    }
    setTheme(next);
  }

  const label = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
  return (
    <button type="button" className={`icon-btn ${className}`} onClick={toggle} aria-label={label} title={label}>
      {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}
