import { createEffect, onCleanup } from 'solid-js'
import { Object3D } from 'three'
import { Falsey } from 'utility-types'

import { useThree, useUpdate } from './hooks'
import { Stages } from './stages'

export function createRef<T>() {
  let ref: T
  const refFn = (el: T) => (ref = el)
  Object.defineProperty(refFn, 'current', {
    get() {
      return ref
    },
    set(val) {
      ref = val
    },
  })

  return refFn as unknown as { current: T | null }
}
type Helper = Object3D & {
  update: () => void
}

type Constructor = new (...args: any[]) => any
type Rest<T> = T extends [infer _, ...infer R] ? R : never

export type MutableRefObject<T> = { current: T }

export function useHelper<T extends Constructor>(
  object3D: MutableRefObject<Object3D | null | undefined> | Falsey | undefined,
  helperConstructor: T,
  ...args: Rest<ConstructorParameters<T>>
) {
  const helper = createRef<Helper>()
  const store = useThree()

  createEffect(() => {
    if (object3D) {
      if (helperConstructor && object3D?.current) {
        helper.current = new (helperConstructor as any)(object3D.current, ...args)
        if (helper.current) {
          store.scene.add(helper.current)
          onCleanup(() => {
            if (helper.current) {
              store.scene.remove(helper.current)
            }
          })
        }
      }
    }

    /**
     * Dispose of the helper if no object 3D is passed
     */
    if (!object3D || (!object3D.current && helper.current)) {
      store.scene.remove(helper.current!)
    }
  })

  useUpdate(() => {
    if (helper?.current?.update) {
      helper.current.update()
    }
  }, Stages.Update)

  return helper
}
