// The contract between the game shell and an instrument. Instruments own their gestures, state
// and drawing; pitch, sound, judging and effects come from shared services in the context.

/**
 * @typedef {object} HandState            produced by core/hands (camera or mouse), in stage pixels
 * @property {string} id
 * @property {'camera'|'mouse'} source
 * @property {number} palm               palm size in px; divide distances and speeds by it
 * @property {{x:number,y:number}[]|null} points   21 landmarks (null for the mouse)
 * @property {boolean} pinching
 * @property {{x:number,y:number}} pinchPoint
 * @property {{x:number,y:number}} tip   index fingertip (smoothed)
 * @property {number} tipSpeed           px/s
 * @property {boolean} fist
 * @property {{x:number,y:number}} center
 * @property {boolean} fresh             no motion history this frame
 *
 * @typedef {object} InstrumentContext
 * @property {object} settings
 * @property {(key:string, params?:object) => string} t
 * @property {{width:number, height:number}} stage
 * @property {object} pitch              core/music/pitch-snap: note(height, lengthRatio)
 * @property {{ pluck(o:object):void, ringTime(freq:number):number }} audio
 * @property {(point:{x:number,y:number}) => {grade:string|null, combo:number, points:number}} judge
 *           report one sounding event; the shell scores it and shows the feedback
 * @property {() => number} combo
 * @property {object} fx                 core/fx/effects
 *
 * @typedef {object} Instrument
 * @property {string} id
 * @property {(ctx:InstrumentContext) => void} init
 * @property {(hands:HandState[], time:number) => void} onHands   time in seconds (audio clock)
 * @property {(command:{type:string}) => void} [onCommand]        e.g. { type:'deleteAt', x, y }
 * @property {(dt:number) => void} update
 * @property {(g:CanvasRenderingContext2D) => void} draw
 * @property {(chord:object|null) => void} onChordChange
 * @property {(width:number, height:number) => void} [onResize]
 * @property {() => void} reset
 * @property {() => void} dispose
 */

import { createAirStrings } from './air-strings/index.js';

export const INSTRUMENTS = {
  'air-strings': createAirStrings,
};

export const DEFAULT_INSTRUMENT = 'air-strings';
