/**
 * Promenade mnésique — parcours 3D du palais (three.js).
 *
 * Portage de `public/js/promenade.js`. La scène est reprise telle quelle : du
 * three.js impératif dans un `useEffect` est la pratique normale, le réécrire en
 * JSX n'apporterait rien.
 *
 * Ce qui change tient au démontage. L'original attachait cinq écouteurs à
 * `document` et `window` et ne les retirait jamais : changer d'onglet laissait
 * les touches ZQSD piloter une caméra invisible, et chaque retour en rajoutait
 * une couche. Ici tout passe par un `AbortController`, et les géométries,
 * matériaux et textures sont libérés — la mémoire GPU ne se ramasse pas toute
 * seule.
 */

import * as THREE from 'three';
import type { Memory } from '../../src/core/types.js';
import { api } from '../api/client.js';
import { LEVEL_COLORS, type VizContext } from './levels.js';

const DIR_PALETTE = [0x22c55e, 0xeab308, 0xf97316, 0xef4444, 0x06b6d4, 0x8b5cf6, 0xec4899, 0x14b8a6];
const HEIGHT = 700;

export function createMount(ctx: VizContext = {}) {
  return async function mount(container: HTMLElement): Promise<() => void> {
    container.innerHTML = '';

    const { memories } = await api.listMemories({ limit: 200 });

    const width = container.clientWidth || 1200;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f0f14);
    scene.fog = new THREE.Fog(0x0f0f14, 20, 100);

    const camera = new THREE.PerspectiveCamera(75, width / HEIGHT, 0.1, 1000);
    camera.position.set(0, 5, 20);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, HEIGHT);
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0x404040, 0.5));
    const sun = new THREE.DirectionalLight(0xffffff, 0.8);
    sun.position.set(0, 20, 10);
    scene.add(sun);
    const lamp = new THREE.PointLight(0x8b5cf6, 1, 50);
    lamp.position.set(0, 10, 0);
    scene.add(lamp);

    // Tout ce qui devra être libéré au démontage.
    const disposables: Array<{ dispose: () => void }> = [];
    const track = <T extends { dispose: () => void }>(item: T): T => {
      disposables.push(item);
      return item;
    };

    const floorGeometry = track(new THREE.PlaneGeometry(200, 200));
    const floorMaterial = track(
      new THREE.MeshStandardMaterial({ color: 0x1a1a24, roughness: 0.8, metalness: 0.2 })
    );
    const floor = new THREE.Mesh(floorGeometry, floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);

    const grid = new THREE.GridHelper(200, 40, 0x3f3f4e, 0x252532);
    scene.add(grid);
    disposables.push(grid);

    // Un pilier par lieu mental, ses traces en orbite autour.
    const directories = [...new Set(memories.map((m) => m.directory))];
    const angleStep = (2 * Math.PI) / Math.max(1, directories.length);
    const radius = 40;

    /** Une sphère porte sa trace et sa hauteur de repos dans `userData`. */
    interface MemorySphere extends THREE.Mesh {
      material: THREE.MeshStandardMaterial;
      userData: { memory: Memory; originalY: number };
    }
    const spheres: MemorySphere[] = [];

    directories.forEach((dir, i) => {
      const color = DIR_PALETTE[i % DIR_PALETTE.length];
      const angle = i * angleStep;
      const centerX = radius * Math.cos(angle);
      const centerZ = radius * Math.sin(angle);

      const pillar = new THREE.Mesh(
        track(new THREE.CylinderGeometry(0.5, 0.5, 8, 16)),
        track(new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.3 }))
      );
      pillar.position.set(centerX, 4, centerZ);
      scene.add(pillar);

      const labelCanvas = document.createElement('canvas');
      labelCanvas.width = 256;
      labelCanvas.height = 64;
      const labelCtx = labelCanvas.getContext('2d')!;
      labelCtx.fillStyle = '#e4e4e7';
      labelCtx.font = 'bold 24px sans-serif';
      labelCtx.textAlign = 'center';
      labelCtx.fillText(dir.split(/[\\/]/).pop() || dir, 128, 40);

      const label = new THREE.Sprite(
        track(new THREE.SpriteMaterial({ map: track(new THREE.CanvasTexture(labelCanvas)) }))
      );
      label.position.set(centerX, 10, centerZ);
      label.scale.set(10, 2.5, 1);
      scene.add(label);

      const group = memories.filter((m) => m.directory === dir);
      group.forEach((memory, j) => {
        const memAngle = (j / Math.max(1, group.length)) * Math.PI * 2;
        const memRadius = 8 + (j % 3) * 3;
        const x = centerX + memRadius * Math.cos(memAngle);
        const z = centerZ + memRadius * Math.sin(memAngle);
        // Hauteur dérivée de l'index, pas aléatoire : la scène doit être la même
        // d'une visite à l'autre, sinon le palais n'est plus un lieu de mémoire.
        const y = 2 + ((j * 7) % 30) / 10;

        const size = 0.5 + (memory.saillance / 100) * 1.5;
        const levelColor = LEVEL_COLORS[memory.currentLevel];

        const sphere = new THREE.Mesh(
          track(new THREE.SphereGeometry(size, 16, 16)),
          track(
            new THREE.MeshStandardMaterial({
              color: levelColor,
              emissive: levelColor,
              emissiveIntensity: memory.saillance / 200,
              transparent: true,
              opacity: Math.max(0.4, memory.saillance / 100),
            })
          )
        ) as unknown as MemorySphere;

        sphere.position.set(x, y, z);
        sphere.userData = { memory, originalY: y };
        scene.add(sphere);
        spheres.push(sphere);

        if (memory.photographic) {
          const ring = new THREE.Mesh(
            track(new THREE.TorusGeometry(size * 1.3, 0.1, 8, 32)),
            track(
              new THREE.MeshStandardMaterial({ color: 0x8b5cf6, emissive: 0x8b5cf6, emissiveIntensity: 0.5 })
            )
          );
          ring.position.copy(sphere.position);
          ring.rotation.x = Math.PI / 2;
          scene.add(ring);
        }
      });
    });

    // ── HUD ─────────────────────────────────────────────────────────────────
    const hud = document.createElement('div');
    hud.className = 'promenade-hud';
    hud.innerHTML = `
      <div style="font-weight:600;margin-bottom:.5rem;">🚶 Promenade mnésique</div>
      <div style="color:var(--muted);font-size:.85rem;">
        <div>ZQSD / Flèches : se déplacer</div>
        <div>Clic : capturer la souris</div>
        <div>Double-clic sur une sphère : détail</div>
      </div>
      <div style="margin-top:1rem;"><button type="button" data-role="autoplay">🎬 Auto-play</button></div>`;
    container.appendChild(hud);

    // ── Contrôles ───────────────────────────────────────────────────────────
    const abort = new AbortController();
    const on = <K extends keyof DocumentEventMap>(
      target: Document | Window | HTMLElement,
      type: K | string,
      handler: (e: any) => void
    ) => target.addEventListener(type, handler, { signal: abort.signal } as AddEventListenerOptions);

    const move = { forward: false, backward: false, left: false, right: false };
    const KEYS: Record<string, keyof typeof move> = {
      z: 'forward', arrowup: 'forward',
      s: 'backward', arrowdown: 'backward',
      q: 'left', arrowleft: 'left',
      d: 'right', arrowright: 'right',
    };

    const setKey = (e: KeyboardEvent, value: boolean) => {
      const dir = KEYS[e.key.toLowerCase()];
      if (dir) move[dir] = value;
    };

    on(document, 'keydown', (e) => setKey(e, true));
    on(document, 'keyup', (e) => setKey(e, false));

    let yaw = 0;
    let pitch = 0;
    let pointerLocked = false;

    on(renderer.domElement, 'click', () => {
      if (!pointerLocked) renderer.domElement.requestPointerLock();
    });
    on(document, 'pointerlockchange', () => {
      pointerLocked = document.pointerLockElement === renderer.domElement;
    });
    on(document, 'mousemove', (e: MouseEvent) => {
      if (!pointerLocked) return;
      yaw += e.movementX * 0.002;
      pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch + e.movementY * 0.002));
    });

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    on(renderer.domElement, 'dblclick', (event: MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(spheres)[0];
      if (hit) ctx.onSelectMemory?.((hit.object.userData as { memory: Memory }).memory.id);
    });

    let autoPlay = false;
    let path: THREE.Vector3[] = [];
    let pathIndex = 0;

    const autoBtn = hud.querySelector<HTMLButtonElement>('[data-role="autoplay"]')!;
    on(autoBtn, 'click', () => {
      autoPlay = !autoPlay;
      autoBtn.textContent = autoPlay ? '⏸ Stop' : '🎬 Auto-play';
      if (!autoPlay) return;

      const step = Math.max(1, Math.floor(spheres.length / 20));
      path = spheres.filter((_, i) => i % step === 0).map((s) => s.position.clone());
      pathIndex = 0;
    });

    on(window, 'resize', () => {
      const w = container.clientWidth || width;
      camera.aspect = w / HEIGHT;
      camera.updateProjectionMatrix();
      renderer.setSize(w, HEIGHT);
    });

    // ── Boucle d'animation ──────────────────────────────────────────────────
    let frame = 0;
    const speed = 0.3;

    function animate() {
      frame = requestAnimationFrame(animate);

      if (autoPlay && path.length > 0) {
        const target = path[pathIndex];
        if (camera.position.distanceTo(target) < 2) {
          pathIndex = (pathIndex + 1) % path.length;
        } else {
          camera.position.add(
            new THREE.Vector3().subVectors(target, camera.position).normalize().multiplyScalar(speed * 0.5)
          );
        }
        camera.lookAt(target);
      } else {
        const forward = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(0, yaw, 0));
        const right = new THREE.Vector3(1, 0, 0).applyEuler(new THREE.Euler(0, yaw, 0));

        if (move.forward) camera.position.add(forward.clone().multiplyScalar(speed));
        if (move.backward) camera.position.add(forward.clone().multiplyScalar(-speed));
        if (move.left) camera.position.add(right.clone().multiplyScalar(-speed));
        if (move.right) camera.position.add(right.clone().multiplyScalar(speed));

        camera.rotation.set(pitch, yaw, 0, 'YXZ');
      }

      // La proximité réactive la trace : s'approcher d'un souvenir le ravive.
      const t = Date.now() * 0.001;
      for (const sphere of spheres) {
        const distance = camera.position.distanceTo(sphere.position);
        const material = sphere.material;
        const { memory, originalY } = sphere.userData;

        if (distance < 10) {
          const proximity = 1 - distance / 10;
          material.emissiveIntensity = 0.3 + proximity * 0.7;
          sphere.scale.setScalar(1 + proximity * 0.3);
        } else {
          material.emissiveIntensity = memory.saillance / 200;
          sphere.scale.setScalar(1);
        }

        sphere.position.y = originalY + Math.sin(t + sphere.position.x) * 0.2;
      }

      renderer.render(scene, camera);
    }

    animate();

    return () => {
      cancelAnimationFrame(frame);
      abort.abort(); // retire les cinq écouteurs d'un coup
      if (document.pointerLockElement === renderer.domElement) document.exitPointerLock();

      for (const item of disposables) item.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      container.innerHTML = '';
    };
  };
}
