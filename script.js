const { useState, useEffect, useMemo, useSyncExternalStore, useCallback, createContext, useContext } = React;

// --- Constants & Config ---
const POGEMON_COLLECTION = 'pogemon_v2';
const MIN_POGEMON_IN_DB = 10;
const NEARBY_COUNT = 3;
const SPAWN_RADIUS_MIN = 20; // meters
const SPAWN_RADIUS_MAX = 100; // meters

// --- Websim & Context Setup ---
const room = new WebsimSocket();
const GameContext = createContext(null);
const useGame = () => useContext(GameContext);

// --- Helper Functions ---
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // metres
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
        Math.cos(φ1) * Math.cos(φ2) *
        Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c; // in metres
}

// Simple seeded random number generator for deterministic spawning
function seededRandom(seed) {
    let x = Math.sin(seed) * 10000;
    return x - Math.floor(x);
}

// --- Custom Hooks ---

// Hook for managing Geolocation
function useGeolocation() {
    const [status, setStatus] = useState('initializing');
    const [position, setPosition] = useState(null);
    const [error, setError] = useState(null);

    const init = useCallback(() => {
        if (!navigator.geolocation) {
            setStatus('unsupported');
            return;
        }
        setStatus('locating');
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                setPosition(pos.coords);
                setStatus('ready');
            },
            (err) => {
                setError(err);
                setStatus(err.code === 1 ? 'permission_denied' : 'error');
            },
            { enableHighAccuracy: true }
        );
    }, []);

    useEffect(() => {
        init();
    }, [init]);
    
    return { status, position, error, refresh: init };
}

// Hook for managing Pogemon data and generation
function usePogemonDB() {
    const [isGenerating, setIsGenerating] = useState(false);
    
    const allPogemon = useSyncExternalStore(
        room.collection(POGEMON_COLLECTION).subscribe,
        room.collection(POGEMON_COLLECTION).getList
    ) || [];

    const [isInitialLoadDone, setIsInitialLoadDone] = useState(false);
    useEffect(() => {
        if (allPogemon.length > 0) {
            setIsInitialLoadDone(true);
        } else {
            const timer = setTimeout(() => setIsInitialLoadDone(true), 2500);
            return () => clearTimeout(timer);
        }
    }, [allPogemon.length > 0]);

    const generateSinglePogemon = useCallback(async () => {
        try {
            const conceptCompletion = await websim.chat.completions.create({
                messages: [{
                    role: "system",
                    content: `Generate a new, unique, creature concept. Give it a name, a type (like "Aquatic", "Forest", "Sky", "Rock"), and a short, one-sentence description. Respond with JSON: { "name": string, "type": string, "description": string }`
                }, {
                    role: "user",
                    content: "Create a new creature."
                }],
                json: true,
            });
            const { name, type, description } = JSON.parse(conceptCompletion.content);

            const imageResult = await websim.imageGen({
                prompt: `A cute creature named ${name}, of type ${type}. ${description}. 3D render, cartoon style, full body, on a plain white background.`,
                transparent: true,
                aspect_ratio: "1:1",
            });
            
            await room.collection(POGEMON_COLLECTION).create({
                name,
                type,
                description,
                imageUrl: imageResult.url,
            });
        } catch (error) {
            console.error("Failed to generate a Pogemon:", error);
        }
    }, []);

    useEffect(() => {
        if (isInitialLoadDone && allPogemon.length < MIN_POGEMON_IN_DB && !isGenerating) {
            const needed = MIN_POGEMON_IN_DB - allPogemon.length;
            console.log(`DB is sparse. Generating ${needed} new Pogemon.`);
            setIsGenerating(true);
            
            const generationPromises = Array.from({ length: needed }, () => generateSinglePogemon());

            Promise.all(generationPromises)
                .catch((err) => console.error("An error occurred during bulk Pogemon generation:", err))
                .finally(() => setIsGenerating(false));
        }
    }, [isInitialLoadDone, allPogemon.length, isGenerating, generateSinglePogemon]);

    return { allPogemon, isGenerating, isDBReady: isInitialLoadDone };
}

// --- Main Game Provider ---
function GameProvider({ children }) {
    const { status: geoStatus, position: userPosition, refresh: refreshGeo } = useGeolocation();
    const { allPogemon, isGenerating, isDBReady } = usePogemonDB();
    
    const [nearbyPokemons, setNearbyPokemons] = useState([]);
    const [activePogemon, setActivePogemon] = useState(null);

    const gameStatus = useMemo(() => {
        if (geoStatus === 'initializing' || !isDBReady) return 'initializing';
        if (isGenerating) return 'generating';
        if (geoStatus === 'locating') return 'locating';
        if (geoStatus === 'permission_denied') return 'needs_permission';
        if (geoStatus === 'error' || geoStatus === 'unsupported') return 'error';
        return 'ready';
    }, [geoStatus, isDBReady, isGenerating]);

    // Spawning logic
    useEffect(() => {
        if (!userPosition || allPogemon.length === 0) return;
        
        const spawned = [];
        const available = [...allPogemon].sort((a,b) => b.created_at.localeCompare(a.created_at));

        for (let i = 0; i < Math.min(NEARBY_COUNT, available.length); i++) {
            const pogemon = available[i];
            const seed = parseInt(pogemon.id.substring(0, 8), 16);
            
            const angle = seededRandom(seed * 1.1) * 360;
            const dist = SPAWN_RADIUS_MIN + seededRandom(seed * 2.2) * (SPAWN_RADIUS_MAX - SPAWN_RADIUS_MIN);

            const angleRad = angle * Math.PI / 180;
            const dy = dist * Math.cos(angleRad);
            const dx = dist * Math.sin(angleRad);

            const lat = userPosition.latitude + (dy / 111111);
            const lon = userPosition.longitude + (dx / (111111 * Math.cos(userPosition.latitude * Math.PI / 180)));
            
            spawned.push({ ...pogemon, lat, lon, spawn: { angle, distance: dist } });
        }
        setNearbyPokemons(spawned);
    }, [userPosition, allPogemon]);
    
    // Distance calculation interval
    useEffect(() => {
        if (!userPosition) return;
        const interval = setInterval(() => {
            setNearbyPokemons(current => current.map(p => ({
                ...p,
                distance: calculateDistance(userPosition.latitude, userPosition.longitude, p.lat, p.lon).toFixed(0)
            })));
        }, 2000);
        return () => clearInterval(interval);
    }, [userPosition]);
    
    const value = { gameStatus, nearbyPokemons, activePogemon, setActivePogemon, refreshGeo, userPosition };

    return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
}

// --- UI Components ---

// Updated UIOverlay: small icon row top-right, and back-button on selection
function UIOverlay() {
    const { nearbyPokemons, setActivePogemon, activePogemon } = useGame();
    return (
        <div className="ui-overlay">
            <div className="ui-overlay-top">
                {activePogemon ? (
                    <button className="back-button" onClick={() => setActivePogemon(null)}>
                        &larr; Back to Map
                    </button>
                ) : (
                    <>
                        {/* placeholder to push icons to right */}
                        <div style={{ width: '1px' }} />
                        <NearbyIcons pokemons={nearbyPokemons} onSelect={setActivePogemon} />
                    </>
                )}
            </div>
            <div className="ui-overlay-bottom">
                 {activePogemon ? (
                    <div className="pogemon-name-plate">
                        <h2>{activePogemon.name}</h2>
                        <p>{activePogemon.type} Type</p>
                    </div>
                 ) : (
                    <Minimap pokemons={nearbyPokemons} onSelect={setActivePogemon} />
                 )}
            </div>
        </div>
    );
}

// New component: renders small clickable icons for nearby Pogemon
function NearbyIcons({ pokemons, onSelect }) {
    return (
        <div className="nearby-icons">
            {pokemons.map(p => (
                <img
                    key={p.id}
                    src={p.imageUrl}
                    alt={p.name}
                    className="nearby-icon"
                    onClick={() => onSelect(p)}
                />
            ))}
        </div>
    );
}

function ARView() {
    const { nearbyPokemons, activePogemon } = useGame();

    return (
        <a-scene
            embedded
            vr-mode-ui="enabled: false"
            arjs="sourceType: webcam; debugUIEnabled: false;"
            renderer="colorManagement: true; antialias: true; alpha: true; preserveDrawingBuffer: true"
            background="color: 0x000000; alpha: 0"
            className="ar-scene"
            key={activePogemon ? 'capture' : 'world'}
        >
            <a-camera gps-new-camera="gpsMinDistance: 5"></a-camera>
            {activePogemon ? (
                <a-image
                    src={activePogemon.imageUrl}
                    scale="2 2 2"
                    position="0 -0.5 -5"
                    look-at="[camera]"
                ></a-image>
            ) : (
                nearbyPokemons.map(p => (
                    <a-image
                        key={p.id}
                        src={p.imageUrl}
                        scale="15 15 15"
                        look-at="[gps-new-camera]"
                        gps-new-entity-place={`latitude: ${p.lat}; longitude: ${p.lon}`}
                    ></a-image>
                ))
            )}
        </a-scene>
    );
}

function NearbyList({ pokemons, onSelect }) {
    if (pokemons.length === 0) {
        return <div className="nearby-list"><h2>Nearby</h2><p>No Pogemon nearby. Try walking around!</p></div>;
    }
    return (
        <div className="nearby-list">
            <h2>Nearby</h2>
            {pokemons.map(p => (
                <div key={p.id} className="pogemon-item" onClick={() => onSelect(p)}>
                    <img src={p.imageUrl} alt={p.name} />
                    <div className="pogemon-info">
                        <h3>{p.name}</h3>
                        <p>{p.distance ? `${p.distance}m away` : 'Calculating...'} - {p.type}</p>
                    </div>
                </div>
            ))}
        </div>
    );
}

function Minimap({ pokemons, onSelect }) {
    const MAP_SIZE = 120;
    const MAX_DIST = SPAWN_RADIUS_MAX;

    return (
        <div className="minimap" style={{ width: MAP_SIZE, height: MAP_SIZE }}>
            <div className="player-dot"></div>
            <div className="north-indicator">N</div>
            {pokemons.map(p => {
                if (!p.spawn) return null;

                const angleRad = p.spawn.angle * Math.PI / 180;
                const r = (p.spawn.distance / MAX_DIST) * (MAP_SIZE / 2); 
                const x = r * Math.sin(angleRad);
                const y = -r * Math.cos(angleRad);
                const style = {
                    position: 'absolute',
                    top: `calc(50% + ${y}px)`,
                    left: `calc(50% + ${x}px)`,
                    transform: 'translate(-50%, -50%)',
                };
                return <img key={p.id} src={p.imageUrl} alt={p.name} className="pogemon-dot" style={style} onClick={() => onSelect(p)} />;
            })}
        </div>
    );
}

// --- App Entry Point ---
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
    <GameProvider>
        <App />
    </GameProvider>
);