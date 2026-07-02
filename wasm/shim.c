// Box3D -> WASM shim. Minimal C API for the JS game layer.
// Bodies are exposed as integer slot handles. Per-frame state is written into
// a flat float buffer that JS reads directly from WASM memory (no per-body calls).

#include "box3d/box3d.h"

#include <emscripten/emscripten.h>
#include <string.h>

#define MAX_BODIES 1024
#define MAX_HITS 64

// Per-slot state layout (floats): 0-2 pos, 3-6 quat (x,y,z,s), 7 awake, 8 valid, 9-11 linear velocity
#define STATE_STRIDE 12

static b3WorldId g_world;
static b3BodyId g_bodies[MAX_BODIES];
static bool g_valid[MAX_BODIES];
static int g_freeList[MAX_BODIES];
static int g_freeCount = 0;
static int g_highSlot = 0;

static float g_states[MAX_BODIES * STATE_STRIDE];
static float g_hits[MAX_HITS * 4]; // px, py, pz, approachSpeed
static int g_hitCount = 0;

static int AllocSlot( void )
{
	if ( g_freeCount > 0 )
	{
		return g_freeList[--g_freeCount];
	}
	if ( g_highSlot >= MAX_BODIES )
	{
		return -1;
	}
	return g_highSlot++;
}

EMSCRIPTEN_KEEPALIVE
void w3_Init( float gx, float gy, float gz )
{
	if ( b3World_IsValid( g_world ) )
	{
		b3DestroyWorld( g_world );
	}

	b3WorldDef def = b3DefaultWorldDef();
	def.gravity = ( b3Vec3 ){ gx, gy, gz };
	g_world = b3CreateWorld( &def );
	memset( g_valid, 0, sizeof( g_valid ) );
	memset( g_states, 0, sizeof( g_states ) );
	g_freeCount = 0;
	g_highSlot = 0;
	g_hitCount = 0;
}

// type: 0 static, 1 kinematic, 2 dynamic
EMSCRIPTEN_KEEPALIVE
int w3_CreateBoxBody( int type, float px, float py, float pz, float qx, float qy, float qz, float qs, float hx, float hy,
					  float hz, float density, float friction, float restitution, int enableHitEvents )
{
	int slot = AllocSlot();
	if ( slot < 0 )
	{
		return -1;
	}

	b3BodyDef bodyDef = b3DefaultBodyDef();
	bodyDef.type = (b3BodyType)type;
	bodyDef.position = ( b3Pos ){ px, py, pz };
	bodyDef.rotation = ( b3Quat ){ { qx, qy, qz }, qs };
	b3BodyId bodyId = b3CreateBody( g_world, &bodyDef );

	b3BoxHull box = b3MakeBoxHull( hx, hy, hz );
	b3ShapeDef shapeDef = b3DefaultShapeDef();
	shapeDef.density = density;
	shapeDef.baseMaterial.friction = friction;
	shapeDef.baseMaterial.restitution = restitution;
	shapeDef.enableHitEvents = enableHitEvents != 0;
	b3CreateHullShape( bodyId, &shapeDef, &box.base );

	g_bodies[slot] = bodyId;
	g_valid[slot] = true;
	return slot;
}

EMSCRIPTEN_KEEPALIVE
void w3_DestroyBody( int slot )
{
	if ( slot < 0 || slot >= MAX_BODIES || !g_valid[slot] )
	{
		return;
	}
	b3DestroyBody( g_bodies[slot] );
	g_valid[slot] = false;
	g_states[slot * STATE_STRIDE + 8] = 0.0f;
	g_freeList[g_freeCount++] = slot;
}

EMSCRIPTEN_KEEPALIVE
void w3_SetLinearVelocity( int slot, float vx, float vy, float vz )
{
	if ( slot < 0 || slot >= MAX_BODIES || !g_valid[slot] )
	{
		return;
	}
	b3Body_SetLinearVelocity( g_bodies[slot], ( b3Vec3 ){ vx, vy, vz } );
}

EMSCRIPTEN_KEEPALIVE
void w3_SetAngularVelocity( int slot, float wx, float wy, float wz )
{
	if ( slot < 0 || slot >= MAX_BODIES || !g_valid[slot] )
	{
		return;
	}
	b3Body_SetAngularVelocity( g_bodies[slot], ( b3Vec3 ){ wx, wy, wz } );
}

EMSCRIPTEN_KEEPALIVE
void w3_ApplyImpulse( int slot, float ix, float iy, float iz )
{
	if ( slot < 0 || slot >= MAX_BODIES || !g_valid[slot] )
	{
		return;
	}
	b3Body_ApplyLinearImpulseToCenter( g_bodies[slot], ( b3Vec3 ){ ix, iy, iz }, true );
}

EMSCRIPTEN_KEEPALIVE
void w3_Step( float dt, int subStepCount )
{
	b3World_Step( g_world, dt, subStepCount );

	// Refresh the state buffer for all live slots
	for ( int i = 0; i < g_highSlot; ++i )
	{
		float* s = g_states + i * STATE_STRIDE;
		if ( !g_valid[i] )
		{
			s[8] = 0.0f;
			continue;
		}
		b3WorldTransform xf = b3Body_GetTransform( g_bodies[i] );
		b3Vec3 v = b3Body_GetLinearVelocity( g_bodies[i] );
		s[0] = (float)xf.p.x;
		s[1] = (float)xf.p.y;
		s[2] = (float)xf.p.z;
		s[3] = xf.q.v.x;
		s[4] = xf.q.v.y;
		s[5] = xf.q.v.z;
		s[6] = xf.q.s;
		s[7] = b3Body_IsAwake( g_bodies[i] ) ? 1.0f : 0.0f;
		s[8] = 1.0f;
		s[9] = v.x;
		s[10] = v.y;
		s[11] = v.z;
	}

	// Collect hit events for impact feedback
	b3ContactEvents events = b3World_GetContactEvents( g_world );
	int count = events.hitCount < MAX_HITS ? events.hitCount : MAX_HITS;
	g_hitCount = count;
	for ( int i = 0; i < count; ++i )
	{
		const b3ContactHitEvent* hit = events.hitEvents + i;
		g_hits[i * 4 + 0] = (float)hit->point.x;
		g_hits[i * 4 + 1] = (float)hit->point.y;
		g_hits[i * 4 + 2] = (float)hit->point.z;
		g_hits[i * 4 + 3] = hit->approachSpeed;
	}
}

EMSCRIPTEN_KEEPALIVE
float* w3_GetStatesPtr( void )
{
	return g_states;
}

EMSCRIPTEN_KEEPALIVE
int w3_GetStateStride( void )
{
	return STATE_STRIDE;
}

EMSCRIPTEN_KEEPALIVE
int w3_GetHitCount( void )
{
	return g_hitCount;
}

EMSCRIPTEN_KEEPALIVE
float* w3_GetHitsPtr( void )
{
	return g_hits;
}
