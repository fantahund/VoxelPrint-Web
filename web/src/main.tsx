import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@radix-ui/themes/styles.css";
import App from "./App";
import "./styles.css";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("The page has no #root element.");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
