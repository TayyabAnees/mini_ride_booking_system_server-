require('dotenv').config();
const express = require('express');
const supabase = require('./utils/supabaseClient');
const prisma  = require('./utils/prismaClient.js');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

const WebSocket = require('ws');
const http = require('http');


app.use(cors({
    origin: 'http://localhost:3001', // your React frontend's URL
    credentials: true               // if you're using cookies/auth
}));
app.use(express.json());

// Create HTTP server and WebSocket server
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Store active connections
const connections = new Map();
// WebSocket connection handler
wss.on('connection', (ws, req) => {
    console.log('New WebSocket connection');

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'subscribe') {
                // Store connection with user info
                connections.set(data.userId, {
                    ws,
                    userType: data.userType,
                    userId: data.userId
                });
                console.log(`User ${data.userId} subscribed to updates`);
            }
        } catch (error) {
            console.error('Error parsing WebSocket message:', error);
        }
    });

    ws.on('close', () => {
        // Remove connection when client disconnects
        for (const [userId, connection] of connections.entries()) {
            if (connection.ws === ws) {
                connections.delete(userId);
                console.log(`User ${userId} disconnected`);
                break;
            }
        }
    });
});

// Function to broadcast ride updates
function broadcastRideUpdate(rideData, targetUserId = null) {
    const message = JSON.stringify({
        type: 'ride_update',
        data: rideData
    });

    if (targetUserId) {
        // Send to specific user
        const connection = connections.get(targetUserId.toString());
        if (connection && connection.ws.readyState === WebSocket.OPEN) {
            connection.ws.send(message);
        }
    } else {
        // Broadcast to all connected clients
        connections.forEach((connection) => {
            if (connection.ws.readyState === WebSocket.OPEN) {
                connection.ws.send(message);
            }
        });
    }
}



// ─── REGISTER PASSENGER ────────────────────────────────────────────────────────
app.post('/register/passenger', async (req, res) => {
    const { name, email, password, type } = req.body;

    if (type !== 'passenger') return res.status(400).json({ error: 'Invalid user type' });

    // Create user in Supabase Auth
    const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true
    });

    if (authError) return res.status(500).json({ error: authError.message });

    // Insert into User table
    try {
        const user = await prisma.user.create({
            data: {
                auth_id: authUser.user.id,
                name,
                type
            }
        });

        res.status(201).json({ message: 'Passenger registered successfully'});
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── REGISTER DRIVER ───────────────────────────────────────────────────────────
app.post('/register/driver', async (req, res) => {
    const { name, email, password, type, ride_type } = req.body;

    if (type !== 'driver') return res.status(400).json({ error: 'Invalid user type' });

    // Create user in Supabase Auth
    const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true
    });

    if (authError) return res.status(500).json({ error: authError.message });

    try {
        // Insert into User table
        const user = await prisma.user.create({
            data: {
                auth_id: authUser.user.id,
                name,
                type
            }
        });

        // Insert into Driver table
        const driver = await prisma.driver.create({
            data: {
                auth_id: authUser.user.id,
                availabilityStatus: 'unavailable',
                ride_type
            }
        });

        res.status(201).json({
            message: 'Driver registered successfully',
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ─── LOGIN ROUTE ─────────────────────────────────────────────────────
app.post('/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        // 1. Authenticate via Supabase
        const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
            email,
            password
        });

        if (authError) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        const { user, session } = authData;

        // 2. Get user from your User table
        const localUser = await prisma.user.findUnique({
            where: { auth_id: user.id }
        });

        if (!localUser) {
            return res.status(404).json({ error: 'User not found in database' });
        }

        // 3. If user is a driver, also get driver details
        let driver = null;
        if (localUser.type === 'driver') {
            driver = await prisma.driver.findFirst({
                where: { auth_id: user.id }
            });
        }

        // 4. Respond
        res.json({
            message: 'Login successful',
            auth: {
                name:localUser.name,
                ride_type: driver?.ride_type ?? null,
                id:localUser.id,
                auth_id: user.id,
                email: user.email,
                access_token: session.access_token,
                refresh_token: session.refresh_token
            },
            userType: localUser.type,
            driverInfo: driver // null for passengers
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── REQUEST RIDE ───────────────────────────────────────────────────────────
app.post('/request-ride', async (req, res) => {
    const { pickupLocation, dropLocation, rideType, passengerId } = req.body;

    if (!pickupLocation || !dropLocation || !rideType || !passengerId) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        const ride = await prisma.ride.create({
            data: {
                pickupLocation,
                dropLocation,
                rideType,
                status: 'Requested',
                passenger: {
                    connect: { id: passengerId }
                },
            },
            include: {
                passenger: true,
                driver: true
            }
        });

        // Broadcast the new ride request to all available drivers
        broadcastRideUpdate({
            type: 'new_ride_request',
            ride: ride
        });

        res.status(201).json({
            message: 'Ride requested successfully',
            ride,
            requestId: ride.id // Add this for frontend tracking
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── UPDATE RIDE ─────────────────────────────────────────────────────────────
app.put('/update-ride/:rideId', async (req, res) => {
    const { rideId } = req.params;
    const updateData = req.body;

    try {
        const updatedRide = await prisma.ride.update({
            where: { id: parseInt(rideId) },
            data: updateData
        });

        res.status(200).json({
            message: 'Ride updated successfully',
            ride: updatedRide
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ─── GET ALL RIDES BY PASSENGER ID ───────────────────────────────────────────
app.get('/rides/passenger/:passengerId', async (req, res) => {
    const { passengerId } = req.params;

    try {
        const rides = await prisma.ride.findMany({
            where: {
                passengerId: parseInt(passengerId)
            },
            include: {
                driver: true // includes full driver info
            }
        });

        res.status(200).json({ rides });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── GET ALL RIDES BY DRIVER ID ──────────────────────────────────────────────
app.get('/rides/driver/:driverId', async (req, res) => {
    const { driverId } = req.params;

    try {
        const rides = await prisma.ride.findMany({
            where: {
                driverId: parseInt(driverId)
            },
            include: {
                passenger: true // includes full passenger (user) info
            }
        });

        res.status(200).json({ rides });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/accept-ride/:rideId', async (req, res) => {
    const { rideId } = req.params;
    const { driverId } = req.body;

    try {
        const updatedRide = await prisma.ride.update({
            where: { id: parseInt(rideId) },
            data: {
                status: 'Accepted',
                driver: {
                    connect: { id: driverId }
                }
            },
            include: {
                passenger: true,
                driver: true
            }
        });

        // Broadcast ride acceptance to passenger
        broadcastRideUpdate({
            type: 'ride_accepted',
            ride: updatedRide
        }, updatedRide.passengerId);

        res.status(200).json({
            message: 'Ride accepted successfully',
            ride: updatedRide
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/start-ride/:rideId', async (req, res) => {
    const { rideId } = req.params;

    try {
        const updatedRide = await prisma.ride.update({
            where: { id: parseInt(rideId) },
            data: {
                status: 'In Progress'
            },
            include: {
                passenger: true,
                driver: true
            }
        });

        // Broadcast ride start to both passenger and driver
        broadcastRideUpdate({
            type: 'ride_started',
            ride: updatedRide
        }, updatedRide.passengerId);

        broadcastRideUpdate({
            type: 'ride_started',
            ride: updatedRide
        }, updatedRide.driverId);

        res.status(200).json({
            message: 'Ride started successfully',
            ride: updatedRide
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/complete-ride/:rideId', async (req, res) => {
    const { rideId } = req.params;

    try {
        const updatedRide = await prisma.ride.update({
            where: { id: parseInt(rideId) },
            data: {
                status: 'Completed'
            },
            include: {
                passenger: true,
                driver: true
            }
        });

        // Broadcast ride completion to both passenger and driver
        broadcastRideUpdate({
            type: 'ride_completed',
            ride: updatedRide
        }, updatedRide.passengerId);

        broadcastRideUpdate({
            type: 'ride_completed',
            ride: updatedRide
        }, updatedRide.driverId);

        res.status(200).json({
            message: 'Ride completed successfully',
            ride: updatedRide
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/cancel-ride/:rideId', async (req, res) => {
    const { rideId } = req.params;
    const { cancelledBy } = req.body; // 'passenger' or 'driver'

    try {
        const updatedRide = await prisma.ride.update({
            where: { id: parseInt(rideId) },
            data: {
                status: 'Cancelled'
            },
            include: {
                passenger: true,
                driver: true
            }
        });

        // Broadcast ride cancellation
        if (cancelledBy === 'passenger' && updatedRide.driverId) {
            broadcastRideUpdate({
                type: 'ride_cancelled',
                ride: updatedRide,
                cancelledBy: 'passenger'
            }, updatedRide.driverId);
        } else if (cancelledBy === 'driver') {
            broadcastRideUpdate({
                type: 'ride_cancelled',
                ride: updatedRide,
                cancelledBy: 'driver'
            }, updatedRide.passengerId);
        }

        res.status(200).json({
            message: 'Ride cancelled successfully',
            ride: updatedRide
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/update-ride/:rideId', async (req, res) => {
    const { rideId } = req.params;
    const updateData = req.body;

    try {
        const updatedRide = await prisma.ride.update({
            where: { id: parseInt(rideId) },
            data: updateData,
            include: {
                passenger: true,
                driver: true
            }
        });

        // Broadcast the update
        broadcastRideUpdate({
            type: 'ride_updated',
            ride: updatedRide
        }, updatedRide.passengerId);

        if (updatedRide.driverId) {
            broadcastRideUpdate({
                type: 'ride_updated',
                ride: updatedRide
            }, updatedRide.driverId);
        }

        res.status(200).json({
            message: 'Ride updated successfully',
            ride: updatedRide
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/available-drivers/:rideType', async (req, res) => {
    const { rideType } = req.params;

    try {
        const drivers = await prisma.driver.findMany({
            where: {
                availabilityStatus: 'available',
                ride_type: rideType
            },
            include: {
                user: true
            }
        });

        res.status(200).json({ drivers });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
server.listen(3000, () => {
    console.log('Server listening on port 3000');
});