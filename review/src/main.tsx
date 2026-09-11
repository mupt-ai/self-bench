import React from "react";
import { createRoot } from "react-dom/client";
import "./theme.css";
import { WebApp } from "./web/WebApp";

const root = document.getElementById("root");
if (!root) {
  throw new Error("review root is missing");
}

createRoot(root).render(
  <React.StrictMode>
    <WebApp />
  </React.StrictMode>,
);
