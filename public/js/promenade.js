let promenadeScene = null;
let promenadeCamera = null;
let promenadeRenderer = null;
let promenadeMemories = [];
let promenadeMemoryObjects = [];
let promenadeAnimationId = null;
let promenadeMoveState = { forward: false, backward: false, left: false, right: false };
let promenadeAutoPlay = false;
let promenadeAutoPlayPath = [];
let promenadeAutoPlayIndex = 0;

async function initPromenade() {
  const container = document.getElementById('promenadeCanvas');
  if (!container) return;

  container.innerHTML = '';

  try {
    promenadeMemories = await fetchMemories({ limit: 200 });

    const width = container.clientWidth || 1200;
    const height = 700;

    promenadeScene = new THREE.Scene();
    promenadeScene.background = new THREE.Color(0x0f0f14);
    promenadeScene.fog = new THREE.Fog(0x0f0f14, 20, 100);

    promenadeCamera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
    promenadeCamera.position.set(0, 5, 20);

    promenadeRenderer = new THREE.WebGLRenderer({ antialias: true });
    promenadeRenderer.setSize(width, height);
    promenadeRenderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(promenadeRenderer.domElement);

    const ambientLight = new THREE.AmbientLight(0x404040, 0.5);
    promenadeScene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(0, 20, 10);
    promenadeScene.add(directionalLight);

    const pointLight = new THREE.PointLight(0x8b5cf6, 1, 50);
    pointLight.position.set(0, 10, 0);
    promenadeScene.add(pointLight);

    const floorGeometry = new THREE.PlaneGeometry(200, 200);
    const floorMaterial = new THREE.MeshStandardMaterial({
      color: 0x1a1a24,
      roughness: 0.8,
      metalness: 0.2,
    });
    const floor = new THREE.Mesh(floorGeometry, floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    promenadeScene.add(floor);

    const gridHelper = new THREE.GridHelper(200, 40, 0x3f3f4e, 0x252532);
    promenadeScene.add(gridHelper);

    const directories = [...new Set(promenadeMemories.map(m => m.directory))];
    const dirColors = {};
    const colorPalette = [0x22c55e, 0xeab308, 0xf97316, 0xef4444, 0x06b6d4, 0x8b5cf6, 0xec4899, 0x14b8a6];

    directories.forEach((dir, i) => {
      dirColors[dir] = colorPalette[i % colorPalette.length];
    });

    const dirGroups = {};
    directories.forEach(dir => {
      dirGroups[dir] = [];
    });
    promenadeMemories.forEach(m => {
      dirGroups[m.directory].push(m);
    });

    const angleStep = (2 * Math.PI) / directories.length;
    const radius = 40;

    directories.forEach((dir, i) => {
      const angle = i * angleStep;
      const centerX = radius * Math.cos(angle);
      const centerZ = radius * Math.sin(angle);

      const pillarGeometry = new THREE.CylinderGeometry(0.5, 0.5, 8, 16);
      const pillarMaterial = new THREE.MeshStandardMaterial({
        color: dirColors[dir],
        emissive: dirColors[dir],
        emissiveIntensity: 0.3,
      });
      const pillar = new THREE.Mesh(pillarGeometry, pillarMaterial);
      pillar.position.set(centerX, 4, centerZ);
      promenadeScene.add(pillar);

      const labelCanvas = document.createElement('canvas');
      labelCanvas.width = 256;
      labelCanvas.height = 64;
      const ctx = labelCanvas.getContext('2d');
      ctx.fillStyle = '#e4e4e7';
      ctx.font = 'bold 24px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(dir.split('/').pop() || dir, 128, 40);

      const labelTexture = new THREE.CanvasTexture(labelCanvas);
      const labelMaterial = new THREE.SpriteMaterial({ map: labelTexture });
      const label = new THREE.Sprite(labelMaterial);
      label.position.set(centerX, 10, centerZ);
      label.scale.set(10, 2.5, 1);
      promenadeScene.add(label);

      const memories = dirGroups[dir];
      memories.forEach((memory, j) => {
        const memAngle = (j / memories.length) * Math.PI * 2;
        const memRadius = 8 + (j % 3) * 3;
        const x = centerX + memRadius * Math.cos(memAngle);
        const z = centerZ + memRadius * Math.sin(memAngle);
        const y = 2 + Math.random() * 3;

        const size = 0.5 + (memory.saillance / 100) * 1.5;
        const geometry = new THREE.SphereGeometry(size, 16, 16);
        const material = new THREE.MeshStandardMaterial({
          color: LEVEL_COLORS[memory.currentLevel],
          emissive: LEVEL_COLORS[memory.currentLevel],
          emissiveIntensity: memory.saillance / 200,
          transparent: true,
          opacity: Math.max(0.4, memory.saillance / 100),
        });

        const sphere = new THREE.Mesh(geometry, material);
        sphere.position.set(x, y, z);
        sphere.userData = { memory, originalY: y, originalScale: size };
        promenadeScene.add(sphere);
        promenadeMemoryObjects.push(sphere);

        if (memory.photographic) {
          const ringGeometry = new THREE.TorusGeometry(size * 1.3, 0.1, 8, 32);
          const ringMaterial = new THREE.MeshStandardMaterial({
            color: 0x8b5cf6,
            emissive: 0x8b5cf6,
            emissiveIntensity: 0.5,
          });
          const ring = new THREE.Mesh(ringGeometry, ringMaterial);
          ring.position.copy(sphere.position);
          ring.rotation.x = Math.PI / 2;
          promenadeScene.add(ring);
        }
      });
    });

    const hud = document.createElement('div');
    hud.className = 'promenade-hud';
    hud.innerHTML = `
      <div style="font-weight: 600; margin-bottom: 0.5rem;">🚶 Promenade mnésique</div>
      <div style="color: var(--text-muted); font-size: 0.85rem;">
        <div>ZQSD / Flèches: Se déplacer</div>
        <div>Souris: Regarder autour</div>
        <div>Proximité = Rappel</div>
      </div>
      <div style="margin-top: 1rem;">
        <button id="promenadeAutoPlayBtn" style="padding: 0.5rem 1rem; background: var(--primary); border: none; border-radius: 6px; color: var(--text); cursor: pointer;">
          🎬 Auto-play
        </button>
      </div>
    `;
    container.appendChild(hud);

    const controls = document.createElement('div');
    controls.className = 'promenade-controls';
    controls.innerHTML = `
      <span>🎮 Déplacez-vous avec ZQSD ou les flèches • Cliquez sur une sphère pour voir les détails</span>
    `;
    container.appendChild(controls);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'z' || e.key === 'Z' || e.key === 'ArrowUp') promenadeMoveState.forward = true;
      if (e.key === 's' || e.key === 'S' || e.key === 'ArrowDown') promenadeMoveState.backward = true;
      if (e.key === 'q' || e.key === 'Q' || e.key === 'ArrowLeft') promenadeMoveState.left = true;
      if (e.key === 'd' || e.key === 'D' || e.key === 'ArrowRight') promenadeMoveState.right = true;
    });

    document.addEventListener('keyup', (e) => {
      if (e.key === 'z' || e.key === 'Z' || e.key === 'ArrowUp') promenadeMoveState.forward = false;
      if (e.key === 's' || e.key === 'S' || e.key === 'ArrowDown') promenadeMoveState.backward = false;
      if (e.key === 'q' || e.key === 'Q' || e.key === 'ArrowLeft') promenadeMoveState.left = false;
      if (e.key === 'd' || e.key === 'D' || e.key === 'ArrowRight') promenadeMoveState.right = false;
    });

    let mouseX = 0;
    let mouseY = 0;
    let isPointerLocked = false;

    promenadeRenderer.domElement.addEventListener('click', () => {
      if (!isPointerLocked) {
        promenadeRenderer.domElement.requestPointerLock();
      }
    });

    document.addEventListener('pointerlockchange', () => {
      isPointerLocked = document.pointerLockElement === promenadeRenderer.domElement;
    });

    document.addEventListener('mousemove', (e) => {
      if (isPointerLocked) {
        mouseX += e.movementX * 0.002;
        mouseY += e.movementY * 0.002;
        mouseY = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, mouseY));
      }
    });

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    promenadeRenderer.domElement.addEventListener('dblclick', (event) => {
      const rect = promenadeRenderer.domElement.getBoundingClientRect();
      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, promenadeCamera);
      const intersects = raycaster.intersectObjects(promenadeMemoryObjects);

      if (intersects.length > 0) {
        const memory = intersects[0].object.userData.memory;
        currentMemories = [memory];
        showDetail(memory.id);
      }
    });

    document.getElementById('promenadeAutoPlayBtn').addEventListener('click', () => {
      promenadeAutoPlay = !promenadeAutoPlay;
      const btn = document.getElementById('promenadeAutoPlayBtn');
      btn.textContent = promenadeAutoPlay ? '⏸ Stop' : '🎬 Auto-play';

      if (promenadeAutoPlay) {
        promenadeAutoPlayPath = [];
        const step = Math.max(1, Math.floor(promenadeMemoryObjects.length / 20));
        for (let i = 0; i < promenadeMemoryObjects.length; i += step) {
          promenadeAutoPlayPath.push(promenadeMemoryObjects[i].position.clone());
        }
        promenadeAutoPlayIndex = 0;
      }
    });

    function animate() {
      promenadeAnimationId = requestAnimationFrame(animate);

      const speed = 0.3;
      const direction = new THREE.Vector3();

      if (promenadeAutoPlay && promenadeAutoPlayPath.length > 0) {
        const target = promenadeAutoPlayPath[promenadeAutoPlayIndex];
        direction.subVectors(target, promenadeCamera.position).normalize();
        const distance = promenadeCamera.position.distanceTo(target);

        if (distance < 2) {
          promenadeAutoPlayIndex = (promenadeAutoPlayIndex + 1) % promenadeAutoPlayPath.length;
        } else {
          promenadeCamera.position.add(direction.multiplyScalar(speed * 0.5));
        }

        promenadeCamera.lookAt(target);
      } else {
        const forward = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(0, mouseX, 0));
        const right = new THREE.Vector3(1, 0, 0).applyEuler(new THREE.Euler(0, mouseX, 0));

        if (promenadeMoveState.forward) promenadeCamera.position.add(forward.clone().multiplyScalar(speed));
        if (promenadeMoveState.backward) promenadeCamera.position.add(forward.clone().multiplyScalar(-speed));
        if (promenadeMoveState.left) promenadeCamera.position.add(right.clone().multiplyScalar(-speed));
        if (promenadeMoveState.right) promenadeCamera.position.add(right.clone().multiplyScalar(speed));

        promenadeCamera.rotation.set(mouseY, mouseX, 0, 'YXZ');
      }

      promenadeMemoryObjects.forEach(obj => {
        const distance = promenadeCamera.position.distanceTo(obj.position);
        const memory = obj.userData.memory;

        if (distance < 10) {
          const proximity = 1 - (distance / 10);
          obj.material.emissiveIntensity = 0.3 + proximity * 0.7;
          obj.scale.setScalar(1 + proximity * 0.3);
        } else {
          obj.material.emissiveIntensity = memory.saillance / 200;
          obj.scale.setScalar(1);
        }

        obj.position.y = obj.userData.originalY + Math.sin(Date.now() * 0.001 + obj.position.x) * 0.2;
      });

      promenadeRenderer.render(promenadeScene, promenadeCamera);
    }

    animate();

    window.addEventListener('resize', () => {
      const newWidth = container.clientWidth;
      const newHeight = 700;
      promenadeCamera.aspect = newWidth / newHeight;
      promenadeCamera.updateProjectionMatrix();
      promenadeRenderer.setSize(newWidth, newHeight);
    });

  } catch (error) {
    container.innerHTML = `<div class="empty-state"><h3>Erreur</h3><p>${error.message}</p></div>`;
  }
}

function cleanupPromenade() {
  if (promenadeAnimationId) {
    cancelAnimationFrame(promenadeAnimationId);
  }
  if (promenadeRenderer) {
    promenadeRenderer.dispose();
  }
  promenadeScene = null;
  promenadeCamera = null;
  promenadeRenderer = null;
  promenadeMemoryObjects = [];
}
