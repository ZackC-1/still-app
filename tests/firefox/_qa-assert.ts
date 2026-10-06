import { stillIsWorking, type Format2Service } from "./_assertions.js";
import type { Tab } from "./_session.js";

/** Wait for Still's owned feature marker on a service page (the positive sign it is blocking). */
export const waitWorking = (tab: Tab, service: Format2Service) =>
  tab.waitFor(
    `Still to mark the ${service} page with its feature marker`,
    () => stillIsWorking(tab, service),
    Boolean,
  );
