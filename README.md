# orbitwatch

a passion project. like a notebook to me.

*a video of joyriding a satellite over earth will be added here.*

---

orbitwatch is a full-stack WebGL visualization that tracks satellites, orbital debris, and deep space objects in real time. It is designed to be quiet, precise, and exploratory.

## architecture

The project is structured as a monorepo, divided into two halves:

* **frontend**: A React and Three.js interface providing an interactive 3D view of the Earth and its orbital bodies. It features a custom rendering engine, GPU-accelerated orbital mechanics, and time controls.
* **backend**: A Node.js and Express service that quietly ingests, caches, and serves Two-Line Element (TLE) sets and deep space object catalogs, ensuring the simulation remains accurate.

## running locally

```bash
# install dependencies
npm install

# start both frontend and backend
npm run dev
```

* requires Node.js >= 20.0.0.
* frontend runs on `localhost:5173`.
* backend runs on `localhost:3001`.

## tech stack

* **rendering**: Three.js, custom GLSL shaders, KTX2 textures.
* **state**: Zustand for UI and camera modes.
* **telemetry**: `satellite.js` for TLE decoding and orbital projection.
* **ingestion**: Automated background workers for continuous data fetching.
