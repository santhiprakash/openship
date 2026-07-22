"use client";

import { createContext, useContext, useEffect, useState, useCallback } from "react";

type Theme = "light" | "dim" | "dark" | "system";
type ResolvedTheme = "light" | "dim" | "dark";

interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (t: Theme) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "light",
  resolvedTheme: "light",
  setTheme: () => {},
  toggle: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

function isDesktopApp(): boolean {
  return typeof window !== "undefined" && !!(window as { desktop?: { isDesktop?: boolean } }).desktop?.isDesktop;
}

function resolveTheme(t: Theme): ResolvedTheme {
  if (t === "light" || t === "dim" || t === "dark") return t;
  if (typeof window === "undefined") return "light";
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  if (!dark) return "light";
  // Desktop's default dark appearance is the softer "dim"; the web product keeps
  // full "dark". Either way an explicit choice (picker/toggle) still wins above.
  return isDesktopApp() ? "dim" : "dark";
}

function applyTheme(resolved: ResolvedTheme) {
  document.documentElement.setAttribute("data-theme", resolved);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("light");
  const [resolvedTheme, setResolved] = useState<ResolvedTheme>("light");

  // Initialize from localStorage. An explicit stored choice always wins. With
  // no stored preference: the DESKTOP app follows the OS ("system"), while the
  // web product stays light-first. (The desktop window is a native app — users
  // expect it to respect their macOS/Windows appearance.)
  useEffect(() => {
    const stored = localStorage.getItem("theme") as Theme | null;
    const isDesktop = !!(window as { desktop?: { isDesktop?: boolean } }).desktop?.isDesktop;
    const t: Theme =
      stored === "light" || stored === "dim" || stored === "dark" || stored === "system"
        ? stored
        : isDesktop
          ? "system"
          : "light";
    const resolved = resolveTheme(t);
    setThemeState(t);
    setResolved(resolved);
    applyTheme(resolved);
  }, []);

  // Listen for OS preference changes when in system mode
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    function onChange() {
      const r = resolveTheme("system");
      setResolved(r);
      applyTheme(r);
    }
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const setTheme = useCallback((t: Theme) => {
    const resolved = resolveTheme(t);
    setThemeState(t);
    setResolved(resolved);
    localStorage.setItem("theme", t);
    applyTheme(resolved);
  }, []);

  const toggle = useCallback(() => {
    // Cycle light → dim → dark → light, based on what's currently shown.
    const next: Theme =
      resolvedTheme === "light" ? "dim" : resolvedTheme === "dim" ? "dark" : "light";
    setTheme(next);
  }, [resolvedTheme, setTheme]);

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

/** Inline script injected in <head> to set data-theme before hydration - prevents flash */
export function ThemeScript() {
  const script = `
    (function(){
      try {
        var t = localStorage.getItem('theme');
        // window.desktop is injected by the Electron preload before this runs.
        var isDesktop = !!(window.desktop && window.desktop.isDesktop);
        var sysDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        var resolved;
        if (t === 'dark') resolved = 'dark';
        else if (t === 'dim') resolved = 'dim';
        else if (t === 'light') resolved = 'light';
        // 'system': follow the OS. Desktop's default dark appearance is the
        // softer 'dim'; the web product keeps full 'dark'.
        else if (t === 'system') resolved = sysDark ? (isDesktop ? 'dim' : 'dark') : 'light';
        // No stored pref: desktop follows the OS (dark → dim), web stays light-first.
        else resolved = (isDesktop && sysDark) ? 'dim' : 'light';
        document.documentElement.setAttribute('data-theme', resolved);
      } catch (e) {
        document.documentElement.setAttribute('data-theme', 'light');
      }
    })();
  `;
  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}
