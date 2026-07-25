import ReactDOM from "react-dom/client";
import "./i18n/config";

const root = document.getElementById("root") as HTMLElement;

const isNotchWindow =
  typeof window !== "undefined" && new URLSearchParams(window.location.search).has("notch");

async function bootstrap() {
  if (isNotchWindow) {
    const { NotchOverlay } = await import("./components/notch/notch-overlay");
    // 刘海覆盖层窗口：必须强制透明,否则 App.css 的 `body { background: var(--color-background) }`
    // 会让顶部出现一条深色横条。下面三道保险:
    //  1. 走 App.css 已有的 `html[data-platform="mac"] { transparent }` 兜底规则
    //  2. inline style 覆盖
    //  3. 注入 !important style 防止任何后续规则覆盖
    document.documentElement.dataset.platform = "mac";
    document.documentElement.style.background = "transparent";
    document.body.style.cssText =
      "background: transparent !important; margin: 0; overflow: hidden;";
    const reset = document.createElement("style");
    reset.textContent = `
      html, body, #root {
        background: transparent !important;
        background-color: transparent !important;
      }
    `;
    document.head.appendChild(reset);
    ReactDOM.createRoot(root).render(<NotchOverlay />);
    return;
  }

  const { default: App } = await import("./App");
  ReactDOM.createRoot(root).render(<App />);
}

void bootstrap();
