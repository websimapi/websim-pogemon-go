const { useState, useEffect, useMemo, useSyncExternalStore, useCallback } = React;

const POGEMON_COLLECTION = 'pogemon_v1';
const MIN_POGEMON_IN_DB = 10;
const NEARBY_COUNT = 3;

// Websim setup
const room = new WebsimSocket();

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

// --- React Components ---

function App() {
    const [status, setStatus] = useState('initializing'); // initializing, needs_permission, ready, generating
    const [userPosition, setUserPosition] = useState(null);
    const [nearbyPokemons, setNearbyPokemons] = useState([]);
    const [activePogemon, setActivePogemon] = useState(null); // The one being viewed in AR

    const allPogemon = useSyncExternalStore(
        room.collection(POGEMON_COLLECTION).subscribe,
        room.collection(POGEMON_COLLECTION).getList
    ) || [];

    // This is to prevent a race condition where we check for pogemon before the first data load.
    const [isDataLoaded, setIsDataLoaded] = useState(false);
    useEffect(() => {
        if (allPogemon.length > 0) {
            setIsDataLoaded(true);
        } else {
             // If after a short delay, allPogemon is still empty, we assume DB is empty or data loaded as empty.
            const timer = setTimeout(() => setIsDataLoaded(true), 2000);
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
            // We can decide if one failure should stop the whole batch. For now, it just logs.
        }
    }, []);

    useEffect(() => {
        // This effect runs once when the app is ready and we have certainty about the DB state
        if (status === 'ready' && isDataLoaded && allPogemon.length < MIN_POGEMON_IN_DB) {
            const needed = MIN_POGEMON_IN_DB - allPogemon.length;
            console.log(`DB is sparse. Generating ${needed} new Pogemon.`);
            
            setStatus('generating');
            
            const generationPromises = [];
            for (let i = 0; i < needed; i++) {
                generationPromises.push(generateSinglePogemon());
            }

            Promise.all(generationPromises)
                .then(() => {
                    console.log("Finished generating new Pogemon.");
                })
                .catch((err) => {
                    console.error("An error occurred during bulk Pogemon generation:", err);
                })
                .finally(() => {
                     // The subscription to allPogemon will update the list automatically.
                     // We just need to signal that generation is complete.
                    setStatus('ready');
                });
        }
    }, [status, isDataLoaded, allPogemon.length, generateSinglePogemon]);

    const spawnNearby = useCallback((position, all) => {
        if (!position || all.length === 0) return;
        
        console.log("Spawning new nearby Pogemon...");
        const spawned = [];
        const available = [...all].sort((a,b) => b.created_at.localeCompare(a.created_at)); // Newest first

        for (let i = 0; i < Math.min(NEARBY_COUNT, available.length); i++) {
            const pogemon = available[i];
            const seed = parseInt(pogemon.id.substring(0, 8), 16);
            
            const randomAngle = seededRandom(seed * 1.1) * 360; // degrees
            const randomDist = 20 + seededRandom(seed * 2.2) * 80; // 20-100 meters

            const angleRad = randomAngle * Math.PI / 180;
            const dy = randomDist * Math.cos(angleRad);
            const dx = randomDist * Math.sin(angleRad);

            const newLat = position.latitude + (dy / 111111);
            const newLon = position.longitude + (dx / (111111 * Math.cos(position.latitude * Math.PI / 180)));
            
            spawned.push({
                ...pogemon,
                lat: newLat,
                lon: newLon,
                distance: '...',
                angle: randomAngle,
                spawnDistance: randomDist,
            });
        }
        setNearbyPokemons(spawned);
    }, []);

    useEffect(() => {
        if (status === 'ready' && userPosition && allPogemon.length > 0) {
            spawnNearby(userPosition, allPogemon);
        }
    }, [status, userPosition, allPogemon, spawnNearby]);

    useEffect(() => {
        if (!userPosition) return;
        const interval = setInterval(() => {
            setNearbyPokemons(currentNearby =>
                currentNearby.map(p => ({
                    ...p,
                    distance: calculateDistance(userPosition.latitude, userPosition.longitude, p.lat, p.lon).toFixed(0)
                }))
            );
        }, 2000);
        return () => clearInterval(interval);
    }, [userPosition]);

    const init = () => {
        if (!navigator.geolocation) {
            setStatus('unsupported');
            return;
        }
        setStatus('locating');
        navigator.geolocation.getCurrentPosition(
            (position) => {
                setUserPosition(position.coords);
                setStatus('ready');
            },
            (error) => {
                console.error("Geolocation error:", error);
                if (error.code === 1) { // PERMISSION_DENIED
                    setStatus('needs_permission');
                } else {
                    setStatus('error');
                }
            },
            { enableHighAccuracy: true }
        );
    };

    useEffect(() => {
        init();
    }, []);
    
    if (status === 'initializing' || status === 'locating') {
        return <div className="loading-screen"><h1>Starting up...</h1><p>Getting your location to find nearby Pogemon.</p></div>;
    }
    
    if (status === 'generating') {
        return <div className="loading-screen"><h1>Generating World...</h1><p>Creating new Pogemon for you to discover!</p></div>;
    }

    if (status === 'needs_permission') {
        return (
            <div className="permission-screen">
                <h1>Location Access Required</h1>
                <p>We need your location to show you nearby Pogemon. Please grant permission and refresh the page.</p>
                 <button onClick={() => window.location.reload()}>Refresh</button>
            </div>
        );
    }
    
    if (status === 'error' || status === 'unsupported') {
        return <div className="loading-screen"><h1>Error</h1><p>Could not get location. This app requires GPS.</p></div>;
    }

    return (
        <div className="app-container">
            {activePogemon ? (
                <CaptureView pogemon={activePogemon} onBack={() => setActivePogemon(null)} />
            ) : (
                <>
                    <ARSceneWrapper nearbyPokemons={nearbyPokemons} key="ar-scene" />
                    <div className="ui-overlay">
                        <NearbyList pokemons={nearbyPokemons} onSelect={setActivePogemon} />
                        <Minimap pokemons={nearbyPokemons} />
                    </div>
                </>
            )}
        </div>
    );
}

function ARSceneWrapper({ nearbyPokemons }) {
    // By adding a key that changes, we force React to unmount and remount the component,
    // which helps A-Frame and AR.js re-initialize correctly.
    const sceneKey = useMemo(() => nearbyPokemons.map(p => p.id).join('-'), [nearbyPokemons]);

    return (
        <a-scene
            key={sceneKey}
            vr-mode-ui="enabled: false"
            arjs="sourceType: webcam; videoTexture: true; debugUIEnabled: false;"
            renderer="antialias: true; alpha: true"
            className="ar-scene"
            embedded
        >
            <a-camera gps-new-camera='gpsMinDistance: 5'></a-camera>
            {nearbyPokemons.map(p => (
                <a-image
                    key={p.id}
                    src={p.imageUrl}
                    scale="15 15 15"
                    look-at="[gps-new-camera]"
                    gps-new-entity-place={`latitude: ${p.lat}; longitude: ${p.lon}`}
                ></a-image>
            ))}
        </a-scene>
    );
}

function CaptureView({ pogemon, onBack }) {
    // The key forces a full remount when switching to this view, ensuring AR.js initializes correctly.
    return (
        <div className="capture-view" key="capture-scene">
            <button className="back-button" onClick={onBack}>&larr; Back to Map</button>
             <a-scene
                vr-mode-ui="enabled: false"
                arjs="sourceType: webcam; videoTexture: true; debugUIEnabled: false;"
                renderer="antialias: true; alpha: true"
                className="ar-scene"
                embedded
            >
                <a-camera static-camera look-controls="enabled: false" wasd-controls="enabled: false"></a-camera>
                <a-image
                    src={pogemon.imageUrl}
                    scale="2 2 2"
                    position="0 0 -5"
                    look-at="[camera]"
                    animation="property: rotation; to: 0 360 0; loop: true; dur: 10000; easing: linear;"
                ></a-image>
            </a-scene>
            <div className="pogemon-name-plate">
                <h2>{pogemon.name}</h2>
                <p>{pogemon.type} Type</p>
            </div>
        </div>
    );
}


function NearbyList({ pokemons, onSelect }) {
    if (pokemons.length === 0) {
        return (
            <div className="nearby-list">
                <h2>Nearby</h2>
                <p>No Pogemon nearby. Walking around might help!</p>
            </div>
        );
    }
    return (
        <div className="nearby-list">
            <h2>Nearby</h2>
            {pokemons.map(p => (
                <div key={p.id} className="pogemon-item" onClick={() => onSelect(p)}>
                    <img src={p.imageUrl} alt={p.name} />
                    <div className="pogemon-info">
                        <h3>{p.name}</h3>
                        <p>{p.distance}m away - {p.type}</p>
                    </div>
                </div>
            ))}
        </div>
    );
}


function Minimap({ pokemons }) {
    const MAP_SIZE = 120; // px
    const MAX_DIST = 100; // meters, from spawn logic

    return (
        <div className="minimap" style={{ width: MAP_SIZE, height: MAP_SIZE }}>
            <div className="player-dot"></div>
            <div className="north-indicator">N</div>
            {pokemons.map(p => {
                if (typeof p.angle === 'undefined' || typeof p.spawnDistance === 'undefined') return null;

                const angleRad = p.angle * Math.PI / 180;
                // use spawnDistance which is consistent, not the live distance
                const r = (p.spawnDistance / MAX_DIST) * (MAP_SIZE / 2); 
                
                // x and y from center, with North being up
                const x = r * Math.sin(angleRad);
                const y = -r * Math.cos(angleRad);

                const style = {
                    position: 'absolute',
                    top: `calc(50% + ${y}px)`,
                    left: `calc(50% + ${x}px)`,
                    transform: 'translate(-50%, -50%)',
                };

                return (
                    <img
                        key={p.id}
                        src={p.imageUrl}
                        alt={p.name}
                        className="pogemon-dot"
                        style={style}
                        onClick={() => {/* could maybe center on this pogemon or something */}}
                    />
                );
            })}
        </div>
    );
}


const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);