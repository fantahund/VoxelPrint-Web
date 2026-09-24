import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { srgbToLinear } from "../colour";
import type { PlateBox } from "../export/plate";
import type { SceneColours, VoxelModel } from "./buildVoxels";

/** What a right click in the preview landed on. */
export interface Pick {
  /** Which block of the selection it was. */
  readonly block: number;
  /** Where to put the menu, in client coordinates. */
  readonly x: number;
  readonly y: number;
}

/** The corner to corner box of one block, in model coordinates. */
interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

/** Everything that outlives the model: the canvas, the camera, the loop. */
interface Stage {
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly outline: THREE.LineSegments;
  /** The group every model's meshes hang from, so one call empties the build. */
  readonly build: THREE.Group;
  readonly dispose: () => void;
}

/** Everything belonging to one model, thrown away when it is replaced. */
interface Build {
  readonly boxes: THREE.InstancedMesh | null;
  /** The slab and its letters, where there is one. */
  readonly plate: THREE.InstancedMesh | null;
  /** One instanced mesh per block state that has a real model. */
  readonly meshes: readonly THREE.InstancedMesh[];
  /** Shared by every mesh, so switching colour mode is one flag rather than many. */
  readonly meshMaterial: THREE.MeshLambertMaterial;
  /** Where each block sits, for the frame drawn under the pointer. */
  readonly bounds: ReadonlyMap<number, Bounds>;
  readonly dispose: () => void;
}

/**
 * Draws a build.
 *
 * <p>Instanced throughout, which is what makes a large build affordable. A
 * block state that has a real model becomes one {@link THREE.InstancedMesh}
 * holding that model once and a position per block: a thousand torches are one
 * torch and a thousand offsets. Everything else -- chests, signs, anything the
 * game draws by hand -- falls back to a shared unit cube scaled to its shape.
 * Either way the number of draw calls follows the palette, not the build.
 *
 * <p>Three effects, and which is which matters:
 *
 * <ul>
 *   <li>the stage -- canvas, camera, controls, lights, the animation loop --
 *       is built once and outlives every model. Editing a build replaces the
 *       model on every click, and a camera rebuilt along with it would throw
 *       the view back to its starting angle each time.
 *   <li>the build is rebuilt when the model is, which is the geometry alone.
 *   <li>colours are their own effect again: changing a filament rewrites one
 *       buffer per mesh rather than re-uploading every position.
 * </ul>
 *
 * <p>The view is framed once per {@code frame} rather than once per model, so a
 * newly opened project is centred and an edited one is left where it was put.
 *
 * <p>WebGL resources are disposed of by hand. They are not garbage collected,
 * so uploading a few files in a row would otherwise leak the graphics memory of
 * all of them.
 */
export default function Viewer({
  model,
  colours,
  plate,
  plateColours,
  onPick,
  frame,
}: {
  model: VoxelModel;
  colours: SceneColours;
  /**
   * The slab under the build and its letters, as boxes.
   *
   * <p>Drawn here rather than left to the writers so that what is on screen is
   * what comes out of the printer. It is not part of the model: nothing can be
   * picked off it, and it is no block of anybody's build.
   *
   * <p>Its shape and its colours arrive apart, as the build's do, because they
   * change for different reasons: nudging a filament's colour must not rebuild
   * a mesh.
   */
  plate?: readonly PlateBox[];
  /** What each of those boxes prints in, as 0xRRGGBB. */
  plateColours?: readonly number[];
  /** Called when a block is right clicked, or null to leave picking off. */
  onPick?: ((pick: Pick) => void) | null;
  /** Changes when the view should be framed afresh, such as for a new project. */
  frame?: string;
}): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Stage | null>(null);
  const buildRef = useRef<Build | null>(null);
  // Held in refs rather than closed over: the stage is built once, and anything
  // baked into it would keep seeing whichever value existed at that moment.
  const modelRef = useRef(model);
  modelRef.current = model;
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  /**
   * Bumped every time the geometry is built afresh.
   *
   * <p>What the colours depend on, rather than the list of things that happen
   * to cause a rebuild. A fresh instanced mesh starts every colour at black, so
   * a rebuild the colours do not hear about is a build nobody can see.
   */
  const [generation, setGeneration] = useState(0);

  // --- the stage, built once -------------------------------------------------
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return;
    }

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x101114);

    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(renderer.domElement);

    const build = new THREE.Group();
    scene.add(build);

    // Two lights from opposite sides plus ambient, so no face is fully black
    // and the shape of the build stays readable from every angle.
    scene.add(new THREE.AmbientLight(0xffffff, 1.4));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(1, 2, 1.5);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.7);
    fill.position.set(-1.5, -0.5, -1);
    scene.add(fill);

    // The block under the pointer, framed the way the game frames one: dark
    // lines along its edges and nothing else, so it reads as a pointer rather
    // than as a change to the build.
    const outlineGeometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    const outlineMaterial = new THREE.LineBasicMaterial({
      color: 0x000000,
      // Drawn over whatever it surrounds. Without this the frame is buried in
      // the block it is meant to be pointing at.
      depthTest: false,
      transparent: true,
      opacity: 0.9,
    });
    const outline = new THREE.LineSegments(outlineGeometry, outlineMaterial);
    outline.visible = false;
    outline.renderOrder = 1;
    scene.add(outline);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, 0, 0);
    camera.position.set(30, 24, 30);
    controls.update();

    // The canvas takes whatever box it is given rather than choosing a height
    // from its width: it fills a pane of the window now, and that pane's height
    // is the window's, not a ratio of anything.
    const resize = (): void => {
      const width = Math.max(host.clientWidth, 1);
      const height = Math.max(host.clientHeight, 1);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(host);

    // --- picking -------------------------------------------------------------
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    /** Where the pointer is, or null when it has left the canvas. */
    let hovering: { x: number; y: number } | null = null;
    /**
     * Whether the frame under the pointer could have changed.
     *
     * <p>Casting a ray tests every instance of every mesh, so doing it on a
     * still view sixty times a second is work for nothing. It is only worth
     * repeating when the pointer moves, the build turns, or the build itself
     * is replaced.
     */
    let recheck = true;
    const lastCamera = new THREE.Vector3();

    /** Which block is under these client coordinates, or null for a miss. */
    const blockAt = (clientX: number, clientY: number): number | null => {
      const current = buildRef.current;
      if (current === null) {
        return null;
      }
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);

      const pickable = [
        ...current.meshes,
        ...(current.boxes === null ? [] : [current.boxes]),
      ];
      // Nearest first, which is what the raycaster sorts by, so a wall in front
      // is picked rather than the room behind it.
      for (const hit of raycaster.intersectObjects(pickable, false)) {
        const instance = hit.instanceId;
        if (instance === undefined) {
          continue;
        }
        const block =
          hit.object === current.boxes
            ? modelRef.current.solidBlocks[instance]
            : modelRef.current.meshes[current.meshes.indexOf(hit.object as THREE.InstancedMesh)]
                ?.blockIndices[instance];
        if (block !== undefined) {
          return block;
        }
      }
      return null;
    };

    const contextMenu = (event: MouseEvent): void => {
      const handle = pickRef.current;
      if (handle == null) {
        return;
      }
      // Always swallow the browser's own menu while picking is on, or a miss
      // would open it over the preview.
      event.preventDefault();
      const block = blockAt(event.clientX, event.clientY);
      if (block !== null) {
        handle({ block, x: event.clientX, y: event.clientY });
      }
    };

    // Only the position is taken here. Casting a ray on every pointer event
    // would mean several per frame on a build of any size, so the work is left
    // to the draw loop, which runs once a frame and also catches the build
    // turning under a pointer that has not moved.
    const pointerMove = (event: PointerEvent): void => {
      hovering = { x: event.clientX, y: event.clientY };
      recheck = true;
    };
    const pointerLeave = (): void => {
      hovering = null;
      recheck = true;
    };

    renderer.domElement.addEventListener("contextmenu", contextMenu);
    renderer.domElement.addEventListener("pointermove", pointerMove);
    renderer.domElement.addEventListener("pointerleave", pointerLeave);

    let loop = 0;
    /** Which build the frame on screen was worked out against. */
    let outlinedIn: Build | null = null;
    const draw = (): void => {
      loop = requestAnimationFrame(draw);
      controls.update();

      if (!camera.position.equals(lastCamera)) {
        lastCamera.copy(camera.position);
        recheck = true;
      }

      const current = buildRef.current;
      if (current !== outlinedIn) {
        // A rebuilt model means new instances, and the block the last cast
        // found no longer means anything.
        outlinedIn = current;
        recheck = true;
      }

      if (recheck) {
        recheck = false;
        const where =
          hovering === null || pickRef.current == null || current === null
            ? null
            : blockAt(hovering.x, hovering.y);
        const box = where === null || current === null ? undefined : current.bounds.get(where);
        if (box === undefined) {
          outline.visible = false;
        } else {
          outline.visible = true;
          outline.position.set(
            (box.min[0] + box.max[0]) / 2,
            (box.min[1] + box.max[1]) / 2,
            (box.min[2] + box.max[2]) / 2,
          );
          // A shade larger than the block, or the frame and the faces fight
          // over the same pixels and the lines break up as the build turns.
          outline.scale.set(
            (box.max[0] - box.min[0]) * 1.004 + 0.002,
            (box.max[1] - box.min[1]) * 1.004 + 0.002,
            (box.max[2] - box.min[2]) * 1.004 + 0.002,
          );
        }
      }

      renderer.render(scene, camera);
    };
    draw();

    stageRef.current = {
      camera,
      controls,
      outline,
      build,
      dispose: () => {
        cancelAnimationFrame(loop);
        renderer.domElement.removeEventListener("contextmenu", contextMenu);
        renderer.domElement.removeEventListener("pointermove", pointerMove);
        renderer.domElement.removeEventListener("pointerleave", pointerLeave);
        observer.disconnect();
        controls.dispose();
        outlineGeometry.dispose();
        outlineMaterial.dispose();
        renderer.dispose();
        host.removeChild(renderer.domElement);
      },
    };

    return () => {
      stageRef.current?.dispose();
      stageRef.current = null;
    };
  }, []);

  // --- the build, rebuilt with the model -------------------------------------
  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null) {
      return;
    }
    stage.outline.visible = false;

    const disposables: Array<{ dispose: () => void }> = [];

    // Both sides, because a Minecraft model is not a closed solid: grass and
    // flowers are two crossed faces, and a one sided material would make half
    // of every plant vanish depending on where you stand.
    const meshMaterial = new THREE.MeshLambertMaterial({
      side: THREE.DoubleSide,
      vertexColors: colours.materialColours,
    });
    disposables.push(meshMaterial);

    const meshes: THREE.InstancedMesh[] = [];
    const offset = new THREE.Vector3();
    const matrix = new THREE.Matrix4();

    for (const block of model.meshes) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(block.positions, 3));
      geometry.setAttribute("normal", new THREE.BufferAttribute(block.normals, 3));
      geometry.setAttribute("color", new THREE.BufferAttribute(block.colours, 3));
      disposables.push(geometry);

      const mesh = new THREE.InstancedMesh(geometry, meshMaterial, block.blocks);
      for (let i = 0; i < block.blocks; i++) {
        offset.set(
          block.offsets[i * 3] as number,
          block.offsets[i * 3 + 1] as number,
          block.offsets[i * 3 + 2] as number,
        );
        matrix.makeTranslation(offset.x, offset.y, offset.z);
        mesh.setMatrixAt(i, matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(block.blocks * 3), 3);
      stage.build.add(mesh);
      meshes.push(mesh);
    }

    // The plate, as plain boxes. Kept out of the instanced build above because
    // it is not made of blocks and must not be picked.
    let plateMesh: THREE.InstancedMesh | null = null;
    if (plate !== undefined && plate.length > 0) {
      const geometry = new THREE.BoxGeometry(1, 1, 1);
      const material = new THREE.MeshLambertMaterial();
      disposables.push(geometry, material);
      const slab = new THREE.InstancedMesh(geometry, material, plate.length);
      slab.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(plate.length * 3), 3);
      const middle = new THREE.Vector3();
      const size = new THREE.Vector3();
      const still = new THREE.Quaternion();
      plate.forEach((box, i) => {
        const [x0, y0, z0, x1, y1, z1] = box;
        middle.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
        size.set(x1 - x0, y1 - y0, z1 - z0);
        matrix.compose(middle, still, size);
        slab.setMatrixAt(i, matrix);
      });
      slab.instanceMatrix.needsUpdate = true;
      slab.raycast = () => undefined;
      stage.build.add(slab);
      plateMesh = slab;
    }

    // One instance per box, scaled from the unit cube. A stair is two of them,
    // a fence several, a plain block one at full size.
    let boxes: THREE.InstancedMesh | null = null;
    if (model.boxes > 0) {
      const geometry = new THREE.BoxGeometry(1, 1, 1);
      const material = new THREE.MeshLambertMaterial();
      disposables.push(geometry, material);

      boxes = new THREE.InstancedMesh(geometry, material, model.boxes);
      const position = new THREE.Vector3();
      const scale = new THREE.Vector3();
      const noRotation = new THREE.Quaternion();
      for (let i = 0; i < model.boxes; i++) {
        position.set(
          model.positions[i * 3] as number,
          model.positions[i * 3 + 1] as number,
          model.positions[i * 3 + 2] as number,
        );
        scale.set(
          model.scales[i * 3] as number,
          model.scales[i * 3 + 1] as number,
          model.scales[i * 3 + 2] as number,
        );
        matrix.compose(position, noRotation, scale);
        boxes.setMatrixAt(i, matrix);
      }
      boxes.instanceMatrix.needsUpdate = true;
      boxes.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(model.boxes * 3), 3);
      stage.build.add(boxes);
    }

    const theseBoxes = boxes;
    const thisPlate = plateMesh;
    buildRef.current = {
      boxes,
      plate: plateMesh,
      meshes,
      meshMaterial,
      bounds: boundsPerBlock(model),
      dispose: () => {
        for (const mesh of [...meshes, ...(theseBoxes === null ? [] : [theseBoxes]),
          ...(thisPlate === null ? [] : [thisPlate])]) {
          stage.build.remove(mesh);
          mesh.dispose();
        }
        for (const resource of disposables) {
          resource.dispose();
        }
      },
    };
    // Every instance colour of a fresh build starts at black, and the colours
    // are an effect of their own. Saying so here rather than listing whatever
    // this effect happens to depend on is what keeps the two from drifting
    // apart -- they did once, and the whole build went black the moment a
    // plate was worked out for it.
    setGeneration((count) => count + 1);

    return () => {
      buildRef.current?.dispose();
      buildRef.current = null;
    };
    // Colours have an effect of their own, and must not rebuild the geometry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, plate]);

  // --- framing, once per project ---------------------------------------------
  useEffect(() => {
    const stage = stageRef.current;
    const current = buildRef.current;
    if (stage === null || current === null) {
      return;
    }

    // Measured across everything drawn rather than one mesh of it.
    const bounds = new THREE.Box3();
    for (const mesh of [...current.meshes, ...(current.boxes === null ? [] : [current.boxes])]) {
      mesh.computeBoundingBox();
      if (mesh.boundingBox !== null) {
        bounds.union(mesh.boundingBox);
      }
    }
    const sphere = bounds.isEmpty() ? null : bounds.getBoundingSphere(new THREE.Sphere());
    const radius = sphere === null || sphere.radius <= 0 ? 16 : sphere.radius;
    const distance = (radius * 1.4) / Math.sin((stage.camera.fov * Math.PI) / 360);

    stage.controls.target.set(0, 0, 0);
    stage.camera.position.set(distance * 0.7, distance * 0.55, distance * 0.7);
    stage.controls.update();
  }, [frame]);

  // --- colours ----------------------------------------------------------------
  useEffect(() => {
    const current = buildRef.current;
    if (current === null) {
      return;
    }

    // Colours reach a mesh two ways: off its corners, which is how a material
    // or a colour per face speaks, and off the instance, which is how a whole
    // block does. Only one of the two may speak at a time, or a red filament
    // shows through as dark red oak rather than as red.
    const offCorners =
      colours.materialColours || colours.corners.some((corner) => corner !== null);
    if (current.meshMaterial.vertexColors !== offCorners) {
      current.meshMaterial.vertexColors = offCorners;
      current.meshMaterial.needsUpdate = true;
    }

    for (let i = 0; i < current.meshes.length; i++) {
      const mesh = current.meshes[i];
      const attribute = mesh?.instanceColor;
      const next = colours.meshes[i];
      if (attribute == null || next === undefined) {
        continue;
      }
      attribute.array.set(next.subarray(0, attribute.array.length));
      attribute.needsUpdate = true;

      // What the corners say: the filament of each face where they differ, and
      // the material's own colour where they do not.
      const corner = mesh?.geometry.getAttribute("color");
      const own = model.meshes[i]?.colours;
      const wanted = colours.corners[i] ?? own;
      if (corner !== undefined && wanted !== undefined) {
        corner.array.set(wanted.subarray(0, corner.array.length));
        corner.needsUpdate = true;
      }
    }

    const boxes = current.boxes?.instanceColor;
    if (boxes != null) {
      boxes.array.set(colours.boxes.subarray(0, boxes.array.length));
      boxes.needsUpdate = true;
    }

    const slab = current.plate?.instanceColor;
    if (slab != null && plateColours !== undefined) {
      for (let i = 0; i < plateColours.length && i * 3 + 2 < slab.array.length; i++) {
        const colour = plateColours[i] as number;
        slab.setXYZ(
          i,
          srgbToLinear(((colour >> 16) & 0xff) / 255),
          srgbToLinear(((colour >> 8) & 0xff) / 255),
          srgbToLinear((colour & 0xff) / 255),
        );
      }
      slab.needsUpdate = true;
    }
    // After a rebuild as well, which is what the generation is for.
  }, [colours, plateColours, generation, model]);

  return <div className="viewer" ref={hostRef} />;
}

/**
 * Where each block of the build sits, corner to corner.
 *
 * <p>Worked out once per model rather than per pointer move: a hover otherwise
 * means walking every solid in the build, sixty times a second.
 *
 * <p>A block's box is the union of its solids, so a stair is framed around both
 * of its steps and a fence around its post and rails together. One frame per
 * block, which is what the game draws and what somebody is pointing at.
 */
function boundsPerBlock(model: VoxelModel): Map<number, Bounds> {
  const bounds = new Map<number, Bounds>();

  for (let i = 0; i < model.solids; i++) {
    const block = model.solidBlocks[i];
    if (block === undefined) {
      continue;
    }
    const cx = model.positions[i * 3] as number;
    const cy = model.positions[i * 3 + 1] as number;
    const cz = model.positions[i * 3 + 2] as number;
    const sx = (model.scales[i * 3] as number) / 2;
    const sy = (model.scales[i * 3 + 1] as number) / 2;
    const sz = (model.scales[i * 3 + 2] as number) / 2;

    const known = bounds.get(block);
    if (known === undefined) {
      bounds.set(block, {
        min: [cx - sx, cy - sy, cz - sz],
        max: [cx + sx, cy + sy, cz + sz],
      });
      continue;
    }
    known.min[0] = Math.min(known.min[0], cx - sx);
    known.min[1] = Math.min(known.min[1], cy - sy);
    known.min[2] = Math.min(known.min[2], cz - sz);
    known.max[0] = Math.max(known.max[0], cx + sx);
    known.max[1] = Math.max(known.max[1], cy + sy);
    known.max[2] = Math.max(known.max[2], cz + sz);
  }
  return bounds;
}
