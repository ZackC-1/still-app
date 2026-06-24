import { mount } from "svelte";
import "@still/core/ui/tokens.css";
import OptionsApp from "./OptionsApp.svelte";

mount(OptionsApp, { target: document.getElementById("app")! });
