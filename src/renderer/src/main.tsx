import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { IconContext } from "@phosphor-icons/react";
import { App } from "./App";
import "./styles.css";

document.documentElement.dataset.theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

const root = document.getElementById("root");
if (!root) throw new Error("Missing root element");

createRoot(root).render(
  <StrictMode>
    <IconContext.Provider value={{ weight: "light", size: 24 }}>
      <App />
    </IconContext.Provider>
  </StrictMode>,
);
