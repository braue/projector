import { BaseEdge, getStraightPath, useInternalNode, type EdgeProps, type InternalNode } from '@xyflow/react'

// A straight edge that attaches wherever the nodes actually are: it enters and
// leaves each node at the point where the center-to-center line crosses that
// node's border, instead of at a fixed left/right handle. Nodes can then be
// arranged freely — above, below, beside — and the wire always takes the
// shortest visual path.

// Where the segment from this node's center toward the other node's center
// crosses this node's rectangle border.
function borderPoint(node: InternalNode, other: InternalNode) {
  const w = (node.measured.width ?? 0) / 2
  const h = (node.measured.height ?? 0) / 2
  const cx = node.internals.positionAbsolute.x + w
  const cy = node.internals.positionAbsolute.y + h
  const ox = other.internals.positionAbsolute.x + (other.measured.width ?? 0) / 2
  const oy = other.internals.positionAbsolute.y + (other.measured.height ?? 0) / 2

  const dx = ox - cx
  const dy = oy - cy
  if (dx === 0 && dy === 0) return { x: cx, y: cy }

  // Scale the direction vector until it touches the rectangle border.
  const scale = 1 / Math.max(Math.abs(dx) / w, Math.abs(dy) / h)
  return { x: cx + dx * scale, y: cy + dy * scale }
}

export function FloatingEdge({ id, source, target, style, interactionWidth }: EdgeProps) {
  const sourceNode = useInternalNode(source)
  const targetNode = useInternalNode(target)
  if (!sourceNode || !targetNode) return null

  const from = borderPoint(sourceNode, targetNode)
  const to = borderPoint(targetNode, sourceNode)
  const [path] = getStraightPath({
    sourceX: from.x,
    sourceY: from.y,
    targetX: to.x,
    targetY: to.y,
  })

  return <BaseEdge id={id} path={path} style={style} interactionWidth={interactionWidth} />
}
