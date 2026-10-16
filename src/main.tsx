import React from "react";
import { createRoot } from "react-dom/client";
import { Studio } from "./Studio";
import "./style.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Studio />
  </React.StrictMode>,
);
