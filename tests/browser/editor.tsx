import React from "react";
import { createRoot } from "react-dom/client";
import PlateEditor from "../../app/PlateEditor";
import { mathJaxConfig, mathJaxScriptUrl } from "../../app/mathjax-config";

const config = document.createElement("script");
config.textContent = mathJaxConfig;
document.head.appendChild(config);
const script = document.createElement("script");
script.src = mathJaxScriptUrl;
script.onload = () => createRoot(document.getElementById("root")!).render(<PlateEditor />);
document.head.appendChild(script);
