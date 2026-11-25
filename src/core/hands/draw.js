const BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

// Faint skeleton, bright ring on a pinch, small glowing dot on the plucking fingertip.
export function drawHands(g, hands, { showSkeleton }) {
  g.save();
  g.lineCap = 'round';
  for (const hand of hands) {
    if (showSkeleton && hand.points) {
      g.strokeStyle = 'rgba(255, 255, 255, 0.22)';
      g.lineWidth = 2;
      g.beginPath();
      for (const [a, b] of BONES) {
        g.moveTo(hand.points[a].x, hand.points[a].y);
        g.lineTo(hand.points[b].x, hand.points[b].y);
      }
      g.stroke();
      g.fillStyle = 'rgba(255, 255, 255, 0.35)';
      for (const point of hand.points) {
        g.beginPath();
        g.arc(point.x, point.y, 2.5, 0, Math.PI * 2);
        g.fill();
      }
    }
    if (hand.pinching) {
      g.strokeStyle = 'rgba(255, 244, 200, 0.95)';
      g.lineWidth = 3;
      g.beginPath();
      g.arc(hand.pinchPoint.x, hand.pinchPoint.y, 13, 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = 'rgba(255, 244, 200, 0.35)';
      g.fill();
    } else if (!hand.fist) {
      const glow = g.createRadialGradient(hand.tip.x, hand.tip.y, 0, hand.tip.x, hand.tip.y, 16);
      glow.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
      glow.addColorStop(0.3, 'rgba(160, 220, 255, 0.55)');
      glow.addColorStop(1, 'rgba(160, 220, 255, 0)');
      g.fillStyle = glow;
      g.beginPath();
      g.arc(hand.tip.x, hand.tip.y, 16, 0, Math.PI * 2);
      g.fill();
    }
  }
  g.restore();
}
