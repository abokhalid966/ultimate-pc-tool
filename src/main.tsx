import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ClipPicker } from "./ClipPicker";
import { Overlay } from "./Overlay";
import { applyTheme, getThemePref } from "./theme";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

// Before the first render, so a forced Light or Dark theme never flashes the other one.
const theme = getThemePref();
if (theme !== "system") applyTheme(theme);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {window.location.hash === "#overlay" ? <Overlay /> : window.location.hash === "#clip" ? <ClipPicker /> : <App />}
  </React.StrictMode>,
);
