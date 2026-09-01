// main.ts
import { mount } from "svelte";
import "./app.css";
import App from "./App.svelte";
import { installExternalLinkHandler } from "./lib/externalLinks";

installExternalLinkHandler();

const app = mount(App, { target: document.getElementById("app")! });
export default app;
