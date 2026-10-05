<script lang="ts">
  // Review framing only (the element the package's capture script screenshotted), reproduced
  // outside the component under test. Mirrors review.babel `Device`, desktop-popup.html `Frame`
  // and the gallery `Pane`; the screen itself is always the real merged component.
  import type { AnyComponent, FrameSpec } from "./types.js";

  let {
    spec,
    theme,
    x,
    y,
    component: Screen,
    props,
  }: {
    spec: FrameSpec;
    theme: "light" | "dark";
    x: number;
    y: number;
    component: AnyComponent;
    props: Record<string, unknown>;
  } = $props();

  const device = $derived(spec.kind === "device" ? spec : null);
  const sheet = $derived(
    device?.device === "iphone" || device?.device === "android",
  );
  const deviceStyle = $derived.by(() => {
    if (!device) return "";
    const top = device.safeTop ?? 0;
    const bottom = device.safeBottom ?? 0;
    const avail = device.h - top - bottom - (sheet ? 72 : 0);
    return [
      `width:${device.w}px`,
      `height:${device.h}px`,
      `--popup-max-block-size:${avail}px`,
      device.scale ? `--text-scale:${device.scale}` : "",
    ]
      .filter(Boolean)
      .join(";");
  });
</script>

<div style={`position:absolute;left:${x}px;top:${y}px;`}>
  {#if spec.kind === "popup"}
    <div class="p-pane">
      <div
        class={`p-frame ${spec.cls ?? ""}`}
        data-theme={theme}
        data-visual-frame
      >
        {#if spec.innerTextScale}
          <div style={`--text-scale:${spec.innerTextScale}`}>
            <Screen {...props} />
          </div>
        {:else}
          <Screen {...props} />
        {/if}
      </div>
    </div>
  {:else if device}
    <div class="r-pane" style={`width:${device.w}px`}>
      <div
        class={`r-device r-${device.device} ${device.cls ?? ""}`}
        data-theme={theme}
        style={deviceStyle}
        data-visual-frame
      >
        {#if device.device === "mac"}
          <div class="r-titlebar">
            <i></i><i></i><i></i><span>{device.title ?? "Still"}</span>
          </div>
        {/if}
        {#if device.device === "tab"}
          <div class="r-tabbar">
            <span class="r-url">{device.url || "Still · Settings"}</span>
          </div>
        {/if}
        {#if sheet}
          <div
            class="r-page"
            style={`height:${(device.safeTop ?? 0) + 52}px`}
          ></div>
          <div class="r-sheet">
            <div class="r-grab" aria-hidden="true"></div>
            <div
              class="r-body"
              style={`padding-bottom:${device.safeBottom ?? 0}px`}
            >
              <Screen {...props} />
            </div>
          </div>
        {:else}
          <div
            class="r-body"
            style={`padding-top:${device.safeTop ?? 0}px;padding-bottom:${device.safeBottom ?? 0}px`}
          >
            <Screen {...props} />
          </div>
        {/if}
        {#if (device.safeBottom ?? 0) > 0}<div
            class="r-home"
            aria-hidden="true"
          ></div>{/if}
      </div>
    </div>
  {:else if spec.kind === "gallery"}
    <div class="g-pane" style={`width:${spec.width}px`}>
      <div
        class="g-frame still-ui"
        data-theme={theme}
        style={spec.height ? `height:${spec.height}px` : ""}
        data-visual-frame
      >
        <Screen {...props} />
      </div>
    </div>
  {/if}
</div>
