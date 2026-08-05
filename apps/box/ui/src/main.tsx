import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App";
import { ThemeProvider } from "./lib/theme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { startServiceWorkerFromEnv } from "./lib/sw-register";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <TooltipProvider>
        <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <App />
        </BrowserRouter>
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
);

// Offline shell + "a new version is available" (src/sw.js). Fire-and-forget:
// the worker is a nicety and must never delay or break the first paint.
void startServiceWorkerFromEnv();
