import { Accessor, batch, createContext, createEffect, on } from 'solid-js'
import { SetStoreFunction, createStore, produce } from 'solid-js/store'
import * as THREE from 'three'

import { FixedStage, Stage } from './stages'
import { calculateDpr, isOrthographicCamera, prepare, updateCamera } from './utils'

import type { DomEvent, EventManager, PointerCaptureTarget, ThreeEvent } from './events'
import type { Camera } from './utils'

// Keys that shouldn't be copied between R3F stores
export const privateKeys = [
  'set',
  'get',
  'setSize',
  'setFrameloop',
  'setDpr',
  'events',
  'invalidate',
  'advance',
  'size',
  'viewport',
] as const

export type PrivateKeys = (typeof privateKeys)[number]

export type Subscription = {
  ref: RenderCallback
  priority: number
  store: RootState
}

export type Dpr = number | [min: number, max: number]
export type Size = { width: number; height: number; top: number; left: number; updateStyle?: boolean }
export type Viewport = Size & {
  /** The initial pixel ratio */
  initialDpr: number
  /** Current pixel ratio */
  dpr: number
  /** size.width / viewport.width */
  factor: number
  /** Camera distance */
  distance: number
  /** Camera aspect ratio: width / height */
  aspect: number
}

export type RenderCallback = (state: RootState, delta: number, frame?: XRFrame) => void

type LegacyAlways = 'always'
export type FrameloopMode = LegacyAlways | 'auto' | 'demand' | 'never'
type FrameloopRender = 'auto' | 'manual'
export type FrameloopLegacy = 'always' | 'demand' | 'never'
export type Frameloop = FrameloopLegacy | { mode?: FrameloopMode; render?: FrameloopRender; maxDelta?: number }

export type Performance = {
  /** Current performance normal, between min and max */
  current: number
  /** How low the performance can go, between 0 and max */
  min: number
  /** How high the performance can go, between min and max */
  max: number
  /** Time until current returns to max in ms */
  debounce: number
  /** Sets current to min, puts the system in regression */
  regress: () => void
}

export type Renderer = { render: (scene: THREE.Scene, camera: THREE.Camera) => any }
export const isRenderer = (def: any) => !!def?.render

export type StageTypes = Stage | FixedStage

export type InternalState = {
  interaction: THREE.Object3D[]
  hovered: Map<string, ThreeEvent<DomEvent>>
  subscribers: Subscription[]
  capturedMap: Map<number, Map<THREE.Object3D, PointerCaptureTarget>>
  initialClick: [x: number, y: number]
  initialHits: THREE.Object3D[]
  lastEvent: DomEvent | null
  active: boolean
  priority: number
  frames: number
  /** The ordered stages defining the lifecycle. */
  stages: StageTypes[]
  /** Render function flags */
  render: 'auto' | 'manual'
  /** The max delta time between two frames. */
  maxDelta: number
  subscribe: (callback: RenderCallback, priority: number, store: RootState) => () => void
}

export type RootState = {
  /** Set current state */
  set: SetStoreFunction<RootState>
  /** The instance of the renderer */
  gl: THREE.WebGLRenderer
  /** Default camera */
  camera: Camera & { manual?: boolean }
  /** Default scene */
  scene: THREE.Scene
  /** Default raycaster */
  raycaster: THREE.Raycaster
  /** Default clock */
  clock: THREE.Clock
  /** Event layer interface, contains the event handler and the node they're connected to */
  events: EventManager<any>
  /** XR interface */
  xr: { connect: () => void; disconnect: () => void }
  /** Currently used controls */
  controls: THREE.EventDispatcher | null
  /** Normalized event coordinates */
  pointer: THREE.Vector2
  /** @deprecated Normalized event coordinates, use "pointer" instead! */
  mouse: THREE.Vector2
  /* Whether to enable r139's THREE.ColorManagement.legacyMode */
  legacy: boolean
  /** Shortcut to gl.outputEncoding = LinearEncoding */
  linear: boolean
  /** Shortcut to gl.toneMapping = NoTonemapping */
  flat: boolean
  /** Update frame loop flags */
  frameloop: FrameloopLegacy
  /** Adaptive performance interface */
  performance: Performance
  /** Reactive pixel-size of the canvas */
  size: Size
  /** Reactive size of the viewport in threejs units */
  viewport: Viewport & {
    getCurrentViewport: (
      camera?: Camera,
      target?: THREE.Vector3 | Parameters<THREE.Vector3['set']>,
      size?: Size,
    ) => Omit<Viewport, 'dpr' | 'initialDpr'>
  }
  /** Flags the canvas for render, but doesn't render in itself */
  invalidate: (frames?: number) => void
  /** Advance (render) one step */
  advance: (timestamp: number, runGlobalEffects?: boolean) => void
  /** Shortcut to setting the event layer */
  setEvents: (events: Partial<EventManager<any>>) => void
  /**
   * Shortcut to manual sizing
   *
   * @todo before releasing next major version (v9), re-order arguments here to width, height, top, left, updateStyle
   */
  setSize: (width: number, height: number, updateStyle?: boolean, top?: number, left?: number) => void
  /** Shortcut to manual setting the pixel ratio */
  setDpr: (dpr: Dpr) => void
  /** Shortcut to setting frameloop flags */
  setFrameloop: (frameloop: Frameloop) => void
  /** When the canvas was clicked but nothing was hit */
  onPointerMissed?: (event: MouseEvent) => void
  /** If this state model is layerd (via createPortal) then this contains the previous layer */
  previousRoot?: RootState
  /** Internals */
  internal: InternalState
}

export const context = createContext<RootState | null>(null)

const createThreeStore = (
  invalidate: (state?: RootState, frames?: number) => void,
  advance: (timestamp: number, runGlobalEffects?: boolean, state?: RootState, frame?: XRFrame) => void,
): RootState => {
  const position = new THREE.Vector3()
  const defaultTarget = new THREE.Vector3()
  const tempTarget = new THREE.Vector3()
  function getCurrentViewport(
    camera: Camera = rootState.camera,
    target: THREE.Vector3 | Parameters<THREE.Vector3['set']> = defaultTarget,
    size: Size = rootState.size,
  ): Omit<Viewport, 'dpr' | 'initialDpr'> {
    const { width, height, top, left } = size
    const aspect = width / height
    if (target instanceof THREE.Vector3) tempTarget.copy(target)
    else tempTarget.set(...target)
    const distance = camera.getWorldPosition(position).distanceTo(tempTarget)
    if (isOrthographicCamera(camera)) {
      return { width: width / camera.zoom, height: height / camera.zoom, top, left, factor: 1, distance, aspect }
    } else {
      const fov = (camera.fov * Math.PI) / 180 // convert vertical fov to radians
      const h = 2 * Math.tan(fov / 2) * distance // visible height
      const w = h * (width / height)
      return { width: w, height: h, top, left, factor: width / w, distance, aspect }
    }
  }

  let performanceTimeout: ReturnType<typeof setTimeout> | undefined = undefined
  const setPerformanceCurrent = (current: number) => set('performance', 'current', current)

  const pointer = new THREE.Vector2()

  const set: SetStoreFunction<RootState> = (...args: any[]) => {
    //@ts-expect-error
    setRootState(...args)
  }

  const get: Accessor<RootState> = () => rootState

  const [rootState, setRootState] = createStore<RootState>({
    set,

    // Mock objects that have to be configured
    gl: null as unknown as THREE.WebGLRenderer,
    camera: null as unknown as Camera,
    raycaster: null as unknown as THREE.Raycaster,
    events: { priority: 1, enabled: true, connected: false },
    xr: null as unknown as { connect: () => void; disconnect: () => void },

    invalidate: (frames = 1) => invalidate(get(), frames),
    advance: (timestamp: number, runGlobalEffects?: boolean) => advance(timestamp, runGlobalEffects, get()),

    legacy: false,
    linear: false,
    flat: false,
    scene: prepare<THREE.Scene>(new THREE.Scene()),

    controls: null,
    clock: new THREE.Clock(),
    pointer,
    mouse: pointer,

    frameloop: 'always',
    onPointerMissed: undefined,

    performance: {
      current: 1,
      min: 0.5,
      max: 1,
      debounce: 200,
      regress: () => {
        // Clear timeout
        if (performanceTimeout) clearTimeout(performanceTimeout)
        // Set lower bound performance
        if (get().performance.current !== get().performance.min) setPerformanceCurrent(get().performance.min)
        // Go back to upper bound performance after a while unless something regresses meanwhile
        performanceTimeout = setTimeout(() => setPerformanceCurrent(get().performance.max), get().performance.debounce)
      },
    },

    size: { width: 0, height: 0, top: 0, left: 0, updateStyle: false },
    viewport: {
      initialDpr: 0,
      dpr: 0,
      width: 0,
      height: 0,
      top: 0,
      left: 0,
      aspect: 0,
      distance: 0,
      factor: 0,
      getCurrentViewport,
    },

    setEvents: (events: Partial<EventManager<any>>) => set('events', events),
    setSize: (width: number, height: number, updateStyle?: boolean, top?: number, left?: number) => {
      const camera = get().camera
      const size = { width, height, top: top || 0, left: left || 0, updateStyle }
      batch(() => {
        set('viewport', getCurrentViewport(camera, defaultTarget, size))
        set('size', size)
      })
    },
    setDpr: (dpr: Dpr) => {
      const resolved = calculateDpr(dpr)
      return set('viewport', { dpr: resolved, initialDpr: state.viewport.initialDpr || resolved })
    },
    setFrameloop: (frameloop: Frameloop) => {
      const state = get()
      const mode: FrameloopLegacy =
        typeof frameloop === 'string'
          ? frameloop
          : frameloop?.mode === 'auto'
          ? 'always'
          : frameloop?.mode ?? state.frameloop
      const render = typeof frameloop === 'string' ? state.internal.render : frameloop?.render ?? state.internal.render
      const maxDelta =
        typeof frameloop === 'string' ? state.internal.maxDelta : frameloop?.maxDelta ?? state.internal.maxDelta

      const clock = state.clock
      // if frameloop === "never" clock.elapsedTime is updated using advance(timestamp)
      clock.stop()
      clock.elapsedTime = 0

      if (frameloop !== 'never') {
        clock.start()
        clock.elapsedTime = 0
      }
      batch(() => {
        set('frameloop', mode)
        set('internal', { render, maxDelta })
      })
    },
    previousRoot: undefined,
    internal: {
      // Events
      interaction: [],
      hovered: new Map<string, ThreeEvent<DomEvent>>(),
      subscribers: [],
      initialClick: [0, 0],
      initialHits: [],
      capturedMap: new Map(),
      lastEvent: null,

      // Updates
      active: false,
      frames: 0,
      stages: [],
      render: 'auto',
      maxDelta: 1 / 10,
      priority: 0,
      subscribe: (ref: RenderCallback, priority: number, store: RootState) => {
        const state = get()
        const internal = state.internal
        // If this subscription was given a priority, it takes rendering into its own hands
        // For that reason we switch off automatic rendering and increase the manual flag
        // As long as this flag is positive there can be no internal rendering at all
        // because there could be multiple render subscriptions
        set('internal', 'priority', internal.priority + (priority > 0 ? 1 : 0))
        // We use the render flag and deprecate priority
        if (internal.priority && state.internal.render === 'auto') set('internal', 'render', 'manual')

        set(
          'internal',
          'subscribers',
          produce((arr) => arr.push({ ref, priority, store })),
        )
        // Register subscriber and sort layers from lowest to highest, meaning,
        // highest priority renders last (on top of the other frames)
        set(
          'internal',
          'subscribers',
          produce((subscribers) => subscribers.sort((a, b) => a.priority - b.priority)),
        )
        return () => {
          const state = get()
          const internal = state.internal
          if (internal?.subscribers) {
            // Decrease manual flag if this subscription had a priority
            set('internal', 'priority', internal.priority - (priority > 0 ? 1 : 0))
            // We use the render flag and deprecate priority
            if (!internal.priority && state.internal.render === 'manual') set('internal', 'render', 'auto')

            // Remove subscriber from list
            set(
              'internal',
              'subscribers',
              internal.subscribers.filter((s) => s.ref !== ref),
            )
          }
        }
      },
    },
  })

  const state = rootState

  let oldSize = state.size
  let oldDpr = state.viewport.dpr
  let oldCamera = state.camera
  createEffect(
    on(
      () => rootState,
      () => {
        const { camera, size, viewport, gl, set } = rootState

        // Resize camera and renderer on changes to size and pixelratio
        if (size !== oldSize || viewport.dpr !== oldDpr) {
          oldSize = size
          oldDpr = viewport.dpr
          // Update camera & renderer
          updateCamera(camera, size)
          gl.setPixelRatio(viewport.dpr)
          gl.setSize(size.width, size.height, size.updateStyle)
        }

        // Update viewport once the camera changes
        if (camera !== oldCamera) {
          oldCamera = camera
          // Update viewport
          set('viewport', state.viewport.getCurrentViewport(camera))
        }
      },
    ),
  )

  // Invalidate on any change

  createEffect(
    on(
      () => rootState,
      () => invalidate(state),
    ),
  )

  // Return root state
  return rootState
}

export { createThreeStore as createStore }
