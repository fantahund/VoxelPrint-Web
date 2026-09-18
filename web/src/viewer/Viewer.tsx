import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { SceneColours, VoxelModel } from "./buildVoxels";

interface Scene {
  /** The boxes, for blocks the export has no model for. Null when there are none. */
  readonly boxes: THREE.InstancedMesh | null;
  /** One instanced mesh per block state that has a real model. */
  readonly meshes: readonly THREE.InstancedMesh[];
  /** Shared by every mesh, so switching colour mode is one flag rather than many. */
  readonly meshMaterial: THREE.MeshLambertMaterial;
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
 * <p>Geometry and colours are kept in separate effects on purpose. Changing a
 * filament rewrites one buffer per mesh; rebuilding the scene for every colour
 * tweak would throw away and re-upload every position.
 *
 * <p>WebGL resources are disposed of by hand. They are not garbage collected,
 * so uploading a few files in a row would otherwise leak the graphics memory of
 * all of them.
 */
export default function Viewer({
  model,
  colours,
}: {
  model: VoxelModel;
  colours: SceneColours;
}): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<Scene | null>(null);

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
      scene.add(mesh);
      meshes.push(mesh);
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
      scene.add(boxes);
    }

    // Two lights from opposite sides plus ambient, so no face is fully black
    // and the shape of the build stays readable from every angle.
    scene.add(new THREE.AmbientLight(0xffffff, 1.4));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(1, 2, 1.5);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.7);
    fill.position.set(-1.5, -0.5, -1);
    scene.add(fill);

    // Frame the model: back off far enough that the whole build fits, measured
    // across everything drawn rather than one mesh of it.
    const bounds = new THREE.Box3();
    for (const mesh of [...meshes, ...(boxes === null ? [] : [boxes])]) {
      mesh.computeBoundingBox();
      if (mesh.boundingBox !== null) {
        bounds.union(mesh.boundingBox);
      }
    }
    const sphere = bounds.isEmpty() ? null : bounds.getBoundingSphere(new THREE.Sphere());
    const radius = sphere === null || sphere.radius <= 0 ? 16 : sphere.radius;
    const distance = (radius * 1.4) / Math.sin((camera.fov * Math.PI) / 360);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, 0, 0);
    camera.position.set(distance * 0.7, distance * 0.55, distance * 0.7);
    controls.update();

    const resize = (): void => {
      const width = host.clientWidth;
      const height = Math.max(Math.round(width * 0.6), 320);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(host);

    let frame = 0;
    const draw = (): void => {
      frame = requestAnimationFrame(draw);
      controls.update();
      renderer.render(scene, camera);
    };
    draw();

    sceneRef.current = {
      boxes,
      meshes,
      meshMaterial,
      dispose: () => {
        cancelAnimationFrame(frame);
        observer.disconnect();
        controls.dispose();
        for (const mesh of meshes) {
          mesh.dispose();
        }
        boxes?.dispose();
        for (const resource of disposables) {
          resource.dispose();
        }
        renderer.dispose();
        host.removeChild(renderer.domElement);
      },
    };

    return () => {
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
  }, [model]);

  useEffect(() => {
    const current = sceneRef.current;
    if (current === null) {
      return;
    }

    // Material colours come from the geometry, filament colours from the
    // instance. Only one of the two may speak at a time, or a red filament
    // would show through as dark red oak rather than as red.
    if (current.meshMaterial.vertexColors !== colours.materialColours) {
      current.meshMaterial.vertexColors = colours.materialColours;
      current.meshMaterial.needsUpdate = true;
    }

    for (let i = 0; i < current.meshes.length; i++) {
      const attribute = current.meshes[i]?.instanceColor;
      const next = colours.meshes[i];
      if (attribute == null || next === undefined) {
        continue;
      }
      attribute.array.set(next.subarray(0, attribute.array.length));
      attribute.needsUpdate = true;
    }

    const boxes = current.boxes?.instanceColor;
    if (boxes != null) {
      boxes.array.set(colours.boxes.subarray(0, boxes.array.length));
      boxes.needsUpdate = true;
    }
  }, [colours]);

  return <div className="viewer" ref={hostRef} />;
}
