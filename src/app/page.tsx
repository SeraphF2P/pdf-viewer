"use client"

import type React from "react"
import { useRef, useEffect, useState, useCallback, useMemo } from "react"
import { Button } from "~/components/ui/button"
import { Card } from "~/components/ui/card"
import { Separator } from "~/components/ui/separator"
import { Slider } from "~/components/ui/slider"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "~/components/ui/tooltip"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "~/components/ui/dialog"
import { Textarea } from "~/components/ui/textarea"
import {
  ZoomIn,
  ZoomOut,
  ChevronLeft,
  ChevronRight,
  Pen,
  Type,
  Eraser,
  RotateCw,
  Menu,
  X,
  Upload,
  FileText,
  Maximize2,
  Minimize2,
  Move,
  Settings,
  Palette,
  Undo2,
  Redo2,
  Highlighter,
  Camera,
} from "lucide-react"
import { cn } from "~/lib/utils"

interface PDFDocument {
  numPages: number
  getPage: (pageNum: number) => Promise<any>
}

interface Annotation {
  id: string
  type: "ink" | "text" | "highlight"
  page: number
  data: any
  bounds?: { x: number; y: number; width: number; height: number }
}

interface Point {
  x: number
  y: number
}

interface HistoryState {
  annotations: Annotation[]
  timestamp: number
}

export default function PDFViewer() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const annotationCanvasRef = useRef<HTMLCanvasElement>(null)
  const tempCanvasRef = useRef<HTMLCanvasElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const renderTaskRef = useRef<any>(null)
  const animationFrameRef = useRef<number>(null)

  const [pdfDoc, setPdfDoc] = useState<PDFDocument | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [totalPages, setTotalPages] = useState(0)
  const [scale, setScale] = useState(1.2)
  const [rotation, setRotation] = useState(0)
  const [isLoading, setIsLoading] = useState(false)
  const [pdfJsLoaded, setPdfJsLoaded] = useState(false)
  const [activeTool, setActiveTool] = useState<"none" | "ink" | "text" | "erase" | "move" | "highlight">("none")
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [isDrawing, setIsDrawing] = useState(false)
  const [currentPath, setCurrentPath] = useState<Point[]>([])
  const [inkColor, setInkColor] = useState("#ef4444")
  const [inkWidth, setInkWidth] = useState(3)
  const [highlightColor, setHighlightColor] = useState("#fbbf24")
  const [sidebarOpen, setSidebarOpen] = useState(false) // Start closed when no PDF
  const [fileName, setFileName] = useState("")
  const [error, setError] = useState("")
  const [isRendering, setIsRendering] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [userName, setUserName] = useState("User") // Default username

  // Move tool state
  const [selectedAnnotation, setSelectedAnnotation] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [dragOffset, setDragOffset] = useState<Point>({ x: 0, y: 0 })

  // History for undo/redo
  const [history, setHistory] = useState<HistoryState[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)

  // Performance optimization states
  const [needsRedraw, setNeedsRedraw] = useState(false)
  const [lastRenderTime, setLastRenderTime] = useState(0)

  // Text annotation dialog state
  const [textDialog, setTextDialog] = useState({
    open: false,
    x: 0,
    y: 0,
    text: "",
  })

  // Username dialog state
  const [userNameDialog, setUserNameDialog] = useState({
    open: false,
  })

  // Memoized current page annotations for performance
  const currentPageAnnotations = useMemo(() => {
    return annotations.filter((ann) => ann.page === currentPage)
  }, [annotations, currentPage])

  // Add to history for undo/redo
  const addToHistory = useCallback(
    (newAnnotations: Annotation[]) => {
      const newState: HistoryState = {
        annotations: [...newAnnotations],
        timestamp: Date.now(),
      }

      setHistory((prev) => {
        const newHistory = prev.slice(0, historyIndex + 1)
        newHistory.push(newState)
        if (newHistory.length > 50) {
          newHistory.shift()
          return newHistory
        }
        return newHistory
      })
      setHistoryIndex((prev) => Math.min(prev + 1, 49))
    },
    [historyIndex],
  )

  // Undo function
  const undo = useCallback(() => {
    if (historyIndex > 0) {
      const prevState = history[historyIndex - 1]
      setAnnotations(prevState.annotations)
      setHistoryIndex(historyIndex - 1)
      setSelectedAnnotation(null)
    }
  }, [history, historyIndex])

  // Redo function
  const redo = useCallback(() => {
    if (historyIndex < history.length - 1) {
      const nextState = history[historyIndex + 1]
      setAnnotations(nextState.annotations)
      setHistoryIndex(historyIndex + 1)
      setSelectedAnnotation(null)
    }
  }, [history, historyIndex])

  // Calculate annotation bounds for better hit detection
  const calculateAnnotationBounds = useCallback((annotation: Annotation) => {
    if (annotation.type === "text") {
      const textData = annotation.data
      const textWidth = textData.text.length * (textData.size * 0.6)
      const textHeight = textData.size
      return {
        x: textData.x - 5,
        y: textData.y - textHeight - 5,
        width: textWidth + 10,
        height: textHeight + 10,
      }
    } else if (annotation.type === "ink") {
      let minX = Number.POSITIVE_INFINITY,
        minY = Number.POSITIVE_INFINITY,
        maxX = Number.NEGATIVE_INFINITY,
        maxY = Number.NEGATIVE_INFINITY

      annotation.data.forEach((stroke: any) => {
        stroke.points.forEach((point: Point) => {
          minX = Math.min(minX, point.x)
          minY = Math.min(minY, point.y)
          maxX = Math.max(maxX, point.x)
          maxY = Math.max(maxY, point.y)
        })
      })

      const padding = Math.max(10, annotation.data[0]?.width || 5)
      return {
        x: minX - padding,
        y: minY - padding,
        width: maxX - minX + padding * 2,
        height: maxY - minY + padding * 2,
      }
    } else if (annotation.type === "highlight") {
      let minX = Number.POSITIVE_INFINITY,
        minY = Number.POSITIVE_INFINITY,
        maxX = Number.NEGATIVE_INFINITY,
        maxY = Number.NEGATIVE_INFINITY

      annotation.data.forEach((stroke: any) => {
        stroke.points.forEach((point: Point) => {
          minX = Math.min(minX, point.x)
          minY = Math.min(minY, point.y)
          maxX = Math.max(maxX, point.x)
          maxY = Math.max(maxY, point.y)
        })
      })

      const padding = Math.max(15, annotation.data[0]?.width || 10)
      return {
        x: minX - padding,
        y: minY - padding,
        width: maxX - minX + padding * 2,
        height: maxY - minY + padding * 2,
      }
    }
    return { x: 0, y: 0, width: 0, height: 0 }
  }, [])

  // Optimized annotation hit detection
  const findAnnotationAtPoint = useCallback(
    (point: Point): Annotation | null => {
      for (let i = currentPageAnnotations.length - 1; i >= 0; i--) {
        const annotation = currentPageAnnotations[i]
        const bounds = annotation.bounds || calculateAnnotationBounds(annotation)

        if (
          point.x >= bounds.x &&
          point.x <= bounds.x + bounds.width &&
          point.y >= bounds.y &&
          point.y <= bounds.y + bounds.height
        ) {
          return annotation
        }
      }
      return null
    },
    [currentPageAnnotations, calculateAnnotationBounds],
  )

  // Screenshot function
  const takeScreenshot = useCallback(async () => {
    if (!pdfDoc) return

    try {
      // Create a temporary canvas for the screenshot
      const screenshotCanvas = document.createElement("canvas")
      const pdfCanvas = canvasRef.current
      const annotationCanvas = annotationCanvasRef.current

      if (!pdfCanvas || !annotationCanvas) return

      // Set canvas size
      screenshotCanvas.width = pdfCanvas.width
      screenshotCanvas.height = pdfCanvas.height

      const ctx = screenshotCanvas.getContext("2d")
      if (!ctx) return

      // Draw PDF content
      ctx.drawImage(pdfCanvas, 0, 0)

      // Draw annotations
      ctx.drawImage(annotationCanvas, 0, 0)

      // Add watermark
      ctx.save()
      ctx.globalAlpha = 0.3
      ctx.fillStyle = "#000000"
      ctx.font = "24px Arial"
      ctx.textAlign = "right"
      ctx.fillText(`© ${userName}`, screenshotCanvas.width - 20, screenshotCanvas.height - 20)
      ctx.restore()

      // Convert to blob and download
      screenshotCanvas.toBlob((blob) => {
        if (blob) {
          const url = URL.createObjectURL(blob)
          const a = document.createElement("a")
          a.href = url
          a.download = `${fileName.replace(".pdf", "")}_page_${currentPage}_annotated.png`
          document.body.appendChild(a)
          a.click()
          document.body.removeChild(a)
          URL.revokeObjectURL(url)
        }
      }, "image/png")
    } catch (error) {
      console.error("Screenshot failed:", error)
      setError("Failed to take screenshot")
    }
  }, [pdfDoc, fileName, currentPage, userName])

  // Optimized rendering with requestAnimationFrame
  const renderAnnotationsOptimized = useCallback(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current)
    }

    animationFrameRef.current = requestAnimationFrame(() => {
      const annotationCanvas = annotationCanvasRef.current
      if (!annotationCanvas) return

      const ctx = annotationCanvas.getContext("2d")
      if (!ctx) return

      const now = performance.now()
      if (now - lastRenderTime < 16) return

      ctx.clearRect(0, 0, annotationCanvas.width, annotationCanvas.height)
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = "high"

      currentPageAnnotations.forEach((annotation) => {
        const isSelected = selectedAnnotation === annotation.id

        if (annotation.type === "ink") {
          annotation.data.forEach((stroke: any) => {
            ctx.strokeStyle = stroke.color
            ctx.lineWidth = stroke.width
            ctx.lineCap = "round"
            ctx.lineJoin = "round"

            if (isSelected) {
              ctx.shadowColor = "#3b82f6"
              ctx.shadowBlur = 6
              ctx.shadowOffsetX = 0
              ctx.shadowOffsetY = 0
            }

            ctx.beginPath()
            const points = stroke.points
            if (points.length > 1) {
              ctx.moveTo(points[0].x, points[0].y)

              for (let i = 1; i < points.length - 1; i++) {
                const xc = (points[i].x + points[i + 1].x) / 2
                const yc = (points[i].y + points[i + 1].y) / 2
                ctx.quadraticCurveTo(points[i].x, points[i].y, xc, yc)
              }

              if (points.length > 1) {
                ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y)
              }
            }
            ctx.stroke()

            ctx.shadowColor = "transparent"
            ctx.shadowBlur = 0
          })
        } else if (annotation.type === "highlight") {
          annotation.data.forEach((stroke: any) => {
            ctx.globalCompositeOperation = "multiply"
            ctx.strokeStyle = stroke.color
            ctx.lineWidth = stroke.width
            ctx.lineCap = "round"
            ctx.lineJoin = "round"
            ctx.globalAlpha = 0.4

            if (isSelected) {
              ctx.shadowColor = "#3b82f6"
              ctx.shadowBlur = 8
              ctx.shadowOffsetX = 0
              ctx.shadowOffsetY = 0
            }

            ctx.beginPath()
            const points = stroke.points
            if (points.length > 1) {
              ctx.moveTo(points[0].x, points[0].y)

              for (let i = 1; i < points.length - 1; i++) {
                const xc = (points[i].x + points[i + 1].x) / 2
                const yc = (points[i].y + points[i + 1].y) / 2
                ctx.quadraticCurveTo(points[i].x, points[i].y, xc, yc)
              }

              if (points.length > 1) {
                ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y)
              }
            }
            ctx.stroke()

            ctx.globalCompositeOperation = "source-over"
            ctx.globalAlpha = 1
            ctx.shadowColor = "transparent"
            ctx.shadowBlur = 0
          })
        } else if (annotation.type === "text") {
          ctx.font = `${annotation.data.size}px Arial`
          ctx.fillStyle = annotation.data.color

          if (isSelected) {
            ctx.shadowColor = "#3b82f6"
            ctx.shadowBlur = 3
            ctx.shadowOffsetX = 0
            ctx.shadowOffsetY = 0
          }

          ctx.fillText(annotation.data.text, annotation.data.x, annotation.data.y)

          ctx.shadowColor = "transparent"
          ctx.shadowBlur = 0

          if (isSelected) {
            const bounds = annotation.bounds || calculateAnnotationBounds(annotation)
            ctx.strokeStyle = "#3b82f6"
            ctx.lineWidth = 2
            ctx.setLineDash([8, 4])
            ctx.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height)
            ctx.setLineDash([])
          }
        }
      })

      setLastRenderTime(now)
      setNeedsRedraw(false)
    })
  }, [currentPageAnnotations, selectedAnnotation, calculateAnnotationBounds, lastRenderTime])

  // Real-time drawing optimization
  const drawCurrentPath = useCallback(() => {
    const tempCanvas = tempCanvasRef.current
    if (!tempCanvas || !isDrawing || currentPath.length < 2) return

    const ctx = tempCanvas.getContext("2d")
    if (!ctx) return

    ctx.clearRect(0, 0, tempCanvas.width, tempCanvas.height)

    if (activeTool === "highlight") {
      ctx.globalCompositeOperation = "multiply"
      ctx.strokeStyle = highlightColor
      ctx.lineWidth = 20
      ctx.globalAlpha = 0.4
    } else {
      ctx.strokeStyle = inkColor
      ctx.lineWidth = inkWidth
    }

    ctx.lineCap = "round"
    ctx.lineJoin = "round"

    ctx.beginPath()
    ctx.moveTo(currentPath[0].x, currentPath[0].y)

    for (let i = 1; i < currentPath.length - 1; i++) {
      const xc = (currentPath[i].x + currentPath[i + 1].x) / 2
      const yc = (currentPath[i].y + currentPath[i + 1].y) / 2
      ctx.quadraticCurveTo(currentPath[i].x, currentPath[i].y, xc, yc)
    }

    if (currentPath.length > 1) {
      ctx.lineTo(currentPath[currentPath.length - 1].x, currentPath[currentPath.length - 1].y)
    }
    ctx.stroke()

    if (activeTool === "highlight") {
      ctx.globalCompositeOperation = "source-over"
      ctx.globalAlpha = 1
    }
  }, [currentPath, inkColor, inkWidth, highlightColor, isDrawing, activeTool])

  // Load PDF.js library
  useEffect(() => {
    const loadPdfJs = async () => {
      try {
        const script = document.createElement("script")
        script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"

        script.onload = () => {
          if (window.pdfjsLib) {
            window.pdfjsLib.GlobalWorkerOptions.workerSrc =
              "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"
            setPdfJsLoaded(true)
            console.log("PDF.js loaded successfully")
          }
        }

        script.onerror = () => {
          setError("Failed to load PDF.js library")
        }

        document.head.appendChild(script)

        return () => {
          if (document.head.contains(script)) {
            document.head.removeChild(script)
          }
        }
      } catch (err) {
        setError("Error loading PDF.js")
        console.error("PDF.js loading error:", err)
      }
    }

    loadPdfJs()
  }, [])

  // Disable browser features
  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      return false
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey && (e.key === "p" || e.key === "s")) ||
        e.key === "F12" ||
        (e.ctrlKey && e.shiftKey && e.key === "I")
      ) {
        e.preventDefault()
        return false
      }

      if (e.ctrlKey && e.key === "z" && !e.shiftKey) {
        e.preventDefault()
        undo()
      } else if (e.ctrlKey && (e.key === "y" || (e.key === "z" && e.shiftKey))) {
        e.preventDefault()
        redo()
      } else if (e.key === "Delete" && selectedAnnotation) {
        e.preventDefault()
        deleteSelected()
      }
    }

    document.addEventListener("contextmenu", handleContextMenu)
    document.addEventListener("keydown", handleKeyDown)

    return () => {
      document.removeEventListener("contextmenu", handleContextMenu)
      document.removeEventListener("keydown", handleKeyDown)
    }
  }, [undo, redo, selectedAnnotation])

  // Fullscreen functionality
  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().then(() => {
        setIsFullscreen(true)
        setSidebarOpen(false)
      })
    } else {
      document.exitFullscreen().then(() => {
        setIsFullscreen(false)
        if (pdfDoc) setSidebarOpen(true)
      })
    }
  }, [pdfDoc])

  // Listen for fullscreen changes
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement)
      if (!document.fullscreenElement && pdfDoc) {
        setSidebarOpen(true)
      }
    }

    document.addEventListener("fullscreenchange", handleFullscreenChange)
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange)
  }, [pdfDoc])

  // Load PDF file
  const loadPDF = useCallback(
    async (file: File) => {
      if (!pdfJsLoaded || !window.pdfjsLib) {
        setError("PDF.js not loaded yet")
        return
      }

      setIsLoading(true)
      setError("")
      setFileName(file.name)

      try {
        const arrayBuffer = await file.arrayBuffer()
        const loadingTask = window.pdfjsLib.getDocument({ data: arrayBuffer })
        const pdf = await loadingTask.promise

        setPdfDoc(pdf)
        setTotalPages(pdf.numPages)
        setCurrentPage(1)
        setAnnotations([])
        setHistory([])
        setHistoryIndex(-1)
        setSidebarOpen(true) // Open sidebar when PDF is loaded

        console.log(`PDF loaded: ${pdf.numPages} pages`)
      } catch (err) {
        console.error("Error loading PDF:", err)
        setError("Failed to load PDF file")
      } finally {
        setIsLoading(false)
      }
    },
    [pdfJsLoaded],
  )

  // Render PDF page
  const renderPage = useCallback(
    async (pdf: PDFDocument, pageNum: number, currentScale: number, currentRotation: number) => {
      const canvas = canvasRef.current
      const annotationCanvas = annotationCanvasRef.current
      const tempCanvas = tempCanvasRef.current

      if (!canvas || !annotationCanvas || !tempCanvas || !pdf) {
        console.error("Canvas elements or PDF not available")
        return
      }

      if (renderTaskRef.current) {
        try {
          renderTaskRef.current.cancel()
        } catch (err) {
          console.log("Previous render task cancelled")
        }
      }

      setIsRendering(true)

      try {
        const page = await pdf.getPage(pageNum)
        const viewport = page.getViewport({ scale: currentScale, rotation: currentRotation })

        const canvases = [canvas, annotationCanvas, tempCanvas]
        canvases.forEach((canvasEl) => {
          canvasEl.width = viewport.width
          canvasEl.height = viewport.height
          canvasEl.style.width = `${viewport.width}px`
          canvasEl.style.height = `${viewport.height}px`
        })

        const context = canvas.getContext("2d")
        if (!context) {
          console.error("Could not get canvas context")
          return
        }

        context.clearRect(0, 0, canvas.width, canvas.height)

        const renderContext = {
          canvasContext: context,
          viewport: viewport,
        }

        renderTaskRef.current = page.render(renderContext)
        await renderTaskRef.current.promise
        renderTaskRef.current = null

        console.log(`Page ${pageNum} rendered successfully`)
      } catch (err) {
        if (err.name === "RenderingCancelledException") {
          console.log("Render operation was cancelled")
        } else {
          console.error("Error rendering page:", err)
          setError(`Failed to render page ${pageNum}: ${err.message}`)
        }
      } finally {
        setIsRendering(false)
        renderTaskRef.current = null
      }
    },
    [],
  )

  // Update annotation bounds when annotations change
  useEffect(() => {
    const updatedAnnotations = annotations.map((ann) => ({
      ...ann,
      bounds: calculateAnnotationBounds(ann),
    }))

    if (JSON.stringify(updatedAnnotations) !== JSON.stringify(annotations)) {
      setAnnotations(updatedAnnotations)
    }
  }, [annotations])

  // Optimized rendering effects
  useEffect(() => {
    if (pdfDoc && !isRendering) {
      renderPage(pdfDoc, currentPage, scale, rotation)
    }
  }, [pdfDoc, currentPage])

  useEffect(() => {
    if (pdfDoc && !isRendering) {
      const timeoutId = setTimeout(() => {
        renderPage(pdfDoc, currentPage, scale, rotation)
      }, 100)
      return () => clearTimeout(timeoutId)
    }
  }, [scale, rotation])

  useEffect(() => {
    if (!needsRedraw) {
      setNeedsRedraw(true)
    }
  }, [currentPageAnnotations, selectedAnnotation])

  useEffect(() => {
    if (needsRedraw) {
      renderAnnotationsOptimized()
    }
  }, [needsRedraw, renderAnnotationsOptimized])

  useEffect(() => {
    if (isDrawing) {
      drawCurrentPath()
    }
  }, [currentPath, drawCurrentPath])

  // Navigation functions
  const goToPage = useCallback(
    (pageNum: number) => {
      if (pageNum >= 1 && pageNum <= totalPages && pdfDoc && !isRendering) {
        setCurrentPage(pageNum)
        setSelectedAnnotation(null)
      }
    },
    [pdfDoc, totalPages, isRendering],
  )

  const nextPage = () => goToPage(currentPage + 1)
  const prevPage = () => goToPage(currentPage - 1)

  const handleZoom = useCallback(
    (newScale: number) => {
      if (isRendering) return
      const clampedScale = Math.max(0.5, Math.min(3, newScale))
      setScale(clampedScale)
    },
    [isRendering],
  )

  const zoomIn = () => handleZoom(scale + 0.25)
  const zoomOut = () => handleZoom(scale - 0.25)

  const handleRotate = useCallback(() => {
    if (isRendering) return
    const newRotation = (rotation + 90) % 360
    setRotation(newRotation)
  }, [rotation, isRendering])

  const getCanvasCoordinates = (e: React.MouseEvent | React.TouchEvent): Point => {
    const canvas = annotationCanvasRef.current
    if (!canvas) return { x: 0, y: 0 }

    const rect = canvas.getBoundingClientRect()
    const clientX = "touches" in e ? e.touches[0]?.clientX || 0 : e.clientX
    const clientY = "touches" in e ? e.touches[0]?.clientY || 0 : e.clientY

    return {
      x: ((clientX - rect.left) / rect.width) * canvas.width,
      y: ((clientY - rect.top) / rect.height) * canvas.height,
    }
  }

  const startDrawing = (e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault()

    const point = getCanvasCoordinates(e)

    if (activeTool === "move") {
      const annotation = findAnnotationAtPoint(point)
      if (annotation) {
        setSelectedAnnotation(annotation.id)
        setIsDragging(true)

        if (annotation.type === "text") {
          setDragOffset({
            x: point.x - annotation.data.x,
            y: point.y - annotation.data.y,
          })
        } else if (annotation.type === "ink" || annotation.type === "highlight") {
          const firstStroke = annotation.data[0]
          const firstPoint = firstStroke.points[0]
          setDragOffset({
            x: point.x - firstPoint.x,
            y: point.y - firstPoint.y,
          })
        }
      } else {
        setSelectedAnnotation(null)
      }
    } else if (activeTool === "ink" || activeTool === "highlight") {
      setIsDrawing(true)
      setCurrentPath([point])
    } else if (activeTool === "text") {
      setTextDialog({
        open: true,
        x: point.x,
        y: point.y,
        text: "",
      })
    }
  }

  const continueDrawing = (e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault()

    const point = getCanvasCoordinates(e)

    if (activeTool === "move" && isDragging && selectedAnnotation) {
      setAnnotations((prev) =>
        prev.map((ann) => {
          if (ann.id === selectedAnnotation) {
            if (ann.type === "text") {
              return {
                ...ann,
                data: {
                  ...ann.data,
                  x: point.x - dragOffset.x,
                  y: point.y - dragOffset.y,
                },
              }
            } else if (ann.type === "ink" || ann.type === "highlight") {
              const firstStroke = ann.data[0]
              const firstPoint = firstStroke.points[0]
              const deltaX = point.x - dragOffset.x - firstPoint.x
              const deltaY = point.y - dragOffset.y - firstPoint.y

              return {
                ...ann,
                data: ann.data.map((stroke: any) => ({
                  ...stroke,
                  points: stroke.points.map((p: Point) => ({
                    x: p.x + deltaX,
                    y: p.y + deltaY,
                  })),
                })),
              }
            }
          }
          return ann
        }),
      )
    } else if ((activeTool === "ink" || activeTool === "highlight") && isDrawing) {
      setCurrentPath((prev) => [...prev, point])
    }
  }

  const stopDrawing = () => {
    if (activeTool === "move" && isDragging) {
      setIsDragging(false)
      setDragOffset({ x: 0, y: 0 })
      addToHistory(annotations)
    } else if ((activeTool === "ink" || activeTool === "highlight") && isDrawing && currentPath.length > 1) {
      const newAnnotation: Annotation = {
        id: Date.now().toString(),
        type: activeTool,
        page: currentPage,
        data: [
          {
            points: currentPath,
            color: activeTool === "highlight" ? highlightColor : inkColor,
            width: activeTool === "highlight" ? 20 : inkWidth,
          },
        ],
      }

      const newAnnotations = [...annotations, newAnnotation]
      setAnnotations(newAnnotations)
      addToHistory(newAnnotations)

      const tempCanvas = tempCanvasRef.current
      if (tempCanvas) {
        const ctx = tempCanvas.getContext("2d")
        ctx?.clearRect(0, 0, tempCanvas.width, tempCanvas.height)
      }
    }

    setIsDrawing(false)
    setCurrentPath([])
  }

  const handleTextSubmit = () => {
    if (textDialog.text.trim()) {
      const newAnnotation: Annotation = {
        id: Date.now().toString(),
        type: "text",
        page: currentPage,
        data: {
          text: textDialog.text.trim(),
          x: textDialog.x,
          y: textDialog.y,
          color: inkColor,
          size: 16,
        },
      }

      const newAnnotations = [...annotations, newAnnotation]
      setAnnotations(newAnnotations)
      addToHistory(newAnnotations)
    }
    setTextDialog({ open: false, x: 0, y: 0, text: "" })
  }

  const clearPage = () => {
    const newAnnotations = annotations.filter((ann) => ann.page !== currentPage)
    setAnnotations(newAnnotations)
    setSelectedAnnotation(null)
    addToHistory(newAnnotations)
  }

  const deleteSelected = () => {
    if (selectedAnnotation) {
      const newAnnotations = annotations.filter((ann) => ann.id !== selectedAnnotation)
      setAnnotations(newAnnotations)
      setSelectedAnnotation(null)
      addToHistory(newAnnotations)
    }
  }

  const handleFileUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) {
        loadPDF(file)
      }
    },
    [loadPDF],
  )

  const colors = [
    { name: "Red", value: "#ef4444" },
    { name: "Blue", value: "#3b82f6" },
    { name: "Green", value: "#10b981" },
    { name: "Purple", value: "#8b5cf6" },
    { name: "Orange", value: "#f97316" },
    { name: "Black", value: "#000000" },
  ]

  const highlightColors = [
    { name: "Yellow", value: "#fbbf24" },
    { name: "Green", value: "#34d399" },
    { name: "Blue", value: "#60a5fa" },
    { name: "Pink", value: "#f472b6" },
    { name: "Orange", value: "#fb923c" },
    { name: "Purple", value: "#a78bfa" },
  ]

  // Floating toolbar component
  const FloatingToolbar = () => (
    <div className="fixed top-4 left-1/2 transform -translate-x-1/2 z-50 bg-white/95 backdrop-blur-md border border-gray-200 rounded-xl shadow-xl p-3">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={prevPage} disabled={currentPage <= 1 || isRendering}>
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <div className="flex items-center gap-1 px-2">
            <Input
              type="number"
              value={currentPage}
              onChange={(e) => {
                const page = Number.parseInt(e.target.value)
                if (page >= 1 && page <= totalPages) {
                  goToPage(page)
                }
              }}
              className="w-12 text-center text-xs h-6 border-0 bg-transparent"
              min={1}
              max={totalPages}
            />
            <span className="text-xs text-gray-500">/{totalPages}</span>
          </div>
          <Button size="sm" variant="ghost" onClick={nextPage} disabled={currentPage >= totalPages || isRendering}>
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>

        <Separator orientation="vertical" className="h-6" />

        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={zoomOut} disabled={scale <= 0.5 || isRendering}>
            <ZoomOut className="w-4 h-4" />
          </Button>
          <span className="text-xs text-gray-600 min-w-[40px] text-center">{Math.round(scale * 100)}%</span>
          <Button size="sm" variant="ghost" onClick={zoomIn} disabled={scale >= 3 || isRendering}>
            <ZoomIn className="w-4 h-4" />
          </Button>
        </div>

        <Separator orientation="vertical" className="h-6" />

        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant={activeTool === "ink" ? "default" : "ghost"}
                onClick={() => setActiveTool(activeTool === "ink" ? "none" : "ink")}
              >
                <Pen className="w-4 h-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Draw</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant={activeTool === "highlight" ? "default" : "ghost"}
                onClick={() => setActiveTool(activeTool === "highlight" ? "none" : "highlight")}
              >
                <Highlighter className="w-4 h-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Highlight</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant={activeTool === "text" ? "default" : "ghost"}
                onClick={() => setActiveTool(activeTool === "text" ? "none" : "text")}
              >
                <Type className="w-4 h-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Add Text</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant={activeTool === "move" ? "default" : "ghost"}
                onClick={() => setActiveTool(activeTool === "move" ? "none" : "move")}
              >
                <Move className="w-4 h-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Move Annotations</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" variant="ghost" onClick={clearPage}>
                <Eraser className="w-4 h-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Clear Page</TooltipContent>
          </Tooltip>
        </div>

        <Separator orientation="vertical" className="h-6" />

        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" variant="ghost" onClick={undo} disabled={historyIndex <= 0}>
                <Undo2 className="w-4 h-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Undo (Ctrl+Z)</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" variant="ghost" onClick={redo} disabled={historyIndex >= history.length - 1}>
                <Redo2 className="w-4 h-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Redo (Ctrl+Y)</TooltipContent>
          </Tooltip>
        </div>

        <Separator orientation="vertical" className="h-6" />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="ghost" onClick={toggleFullscreen}>
              <Minimize2 className="w-4 h-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Exit Fullscreen</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )

  return (
    <TooltipProvider>
      <div className="flex flex-col h-screen bg-slate-50">
        {!isFullscreen && (
          <header className="bg-white border-b shadow-sm">
            <div className="flex items-center justify-between px-4 py-3">
              <div className="flex items-center gap-3">
                {pdfDoc && (
                  <Button variant="ghost" size="sm" onClick={() => setSidebarOpen(!sidebarOpen)} className="md:hidden">
                    {sidebarOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
                  </Button>
                )}

                <div className="flex items-center gap-3">
                  <FileText className="w-5 h-5 text-blue-600" />
                  <div className="hidden sm:block">
                    <h1 className="font-semibold text-gray-900">PDF Viewer</h1>
                    {fileName && <p className="text-xs text-gray-500 truncate max-w-[200px]">{fileName}</p>}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {!pdfDoc && (
                  <Button onClick={() => fileInputRef.current?.click()} disabled={isLoading || !pdfJsLoaded}>
                    <Upload className="w-4 h-4 mr-2" />
                    {isLoading ? "Loading..." : !pdfJsLoaded ? "Loading PDF.js..." : "Load PDF"}
                  </Button>
                )}

                {pdfDoc && (
                  <>
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="outline" onClick={prevPage} disabled={currentPage <= 1 || isRendering}>
                        <ChevronLeft className="w-4 h-4" />
                      </Button>

                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          value={currentPage}
                          onChange={(e) => {
                            const page = Number.parseInt(e.target.value)
                            if (page >= 1 && page <= totalPages) {
                              goToPage(page)
                            }
                          }}
                          className="w-16 text-center text-sm h-8"
                          min={1}
                          max={totalPages}
                        />
                        <span className="text-sm text-gray-500">of {totalPages}</span>
                      </div>

                      <Button
                        size="sm"
                        variant="outline"
                        onClick={nextPage}
                        disabled={currentPage >= totalPages || isRendering}
                      >
                        <ChevronRight className="w-4 h-4" />
                      </Button>
                    </div>

                    <Separator orientation="vertical" className="h-6" />

                    <div className="flex items-center gap-1">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button size="sm" variant="ghost" onClick={undo} disabled={historyIndex <= 0}>
                            <Undo2 className="w-4 h-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Undo (Ctrl+Z)</TooltipContent>
                      </Tooltip>

                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={redo}
                            disabled={historyIndex >= history.length - 1}
                          >
                            <Redo2 className="w-4 h-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Redo (Ctrl+Y)</TooltipContent>
                      </Tooltip>
                    </div>

                    <Separator orientation="vertical" className="h-6" />

                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="ghost" size="sm" onClick={toggleFullscreen}>
                          {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}</TooltipContent>
                    </Tooltip>

                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setUserNameDialog({ open: true })}
                          className="text-blue-600 hover:text-blue-700"
                        >
                          <Camera className="w-4 h-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Take Screenshot</TooltipContent>
                    </Tooltip>
                  </>
                )}
              </div>
            </div>
          </header>
        )}

        {isFullscreen && pdfDoc && <FloatingToolbar />}

        {error && !isFullscreen && (
          <div className="bg-red-50 border-l-4 border-red-400 p-4">
            <div className="flex">
              <div className="ml-3">
                <p className="text-sm text-red-700">{error}</p>
              </div>
              <button onClick={() => setError("")} className="ml-auto text-red-400 hover:text-red-600">
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        <div className="flex flex-1 overflow-hidden">
          {!isFullscreen && pdfDoc && (
            <aside
              className={cn(
                "bg-white border-r shadow-sm transition-all duration-300 overflow-y-auto",
                sidebarOpen ? "w-80" : "w-0",
                "md:relative absolute md:translate-x-0 z-40 h-full",
              )}
            >
              <div className="p-4 space-y-6">
                <div className="space-y-4">
                  <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                    <Settings className="w-4 h-4" />
                    View Controls
                  </h3>

                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label className="text-sm">Zoom</Label>
                      <span className="text-sm font-medium">{Math.round(scale * 100)}%</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="outline" onClick={zoomOut} disabled={scale <= 0.5 || isRendering}>
                        <ZoomOut className="w-4 h-4" />
                      </Button>
                      <Slider
                        value={[scale]}
                        onValueChange={(value) => handleZoom(value[0])}
                        max={3}
                        min={0.5}
                        step={0.25}
                        className="flex-1"
                      />
                      <Button size="sm" variant="outline" onClick={zoomIn} disabled={scale >= 3 || isRendering}>
                        <ZoomIn className="w-4 h-4" />
                      </Button>
                    </div>

                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleRotate}
                      disabled={isRendering}
                      className="w-full"
                    >
                      <RotateCw className="w-4 h-4 mr-2" />
                      Rotate 90°
                    </Button>
                  </div>
                </div>

                <Separator />

                <div className="space-y-4">
                  <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                    <Palette className="w-4 h-4" />
                    Annotations
                  </h3>

                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      size="sm"
                      variant={activeTool === "ink" ? "default" : "outline"}
                      onClick={() => setActiveTool(activeTool === "ink" ? "none" : "ink")}
                      className="flex flex-col gap-1 h-auto py-3"
                    >
                      <Pen className="w-4 h-4" />
                      <span className="text-xs">Draw</span>
                    </Button>
                    <Button
                      size="sm"
                      variant={activeTool === "highlight" ? "default" : "outline"}
                      onClick={() => setActiveTool(activeTool === "highlight" ? "none" : "highlight")}
                      className="flex flex-col gap-1 h-auto py-3"
                    >
                      <Highlighter className="w-4 h-4" />
                      <span className="text-xs">Highlight</span>
                    </Button>
                    <Button
                      size="sm"
                      variant={activeTool === "text" ? "default" : "outline"}
                      onClick={() => setActiveTool(activeTool === "text" ? "none" : "text")}
                      className="flex flex-col gap-1 h-auto py-3"
                    >
                      <Type className="w-4 h-4" />
                      <span className="text-xs">Text</span>
                    </Button>
                    <Button
                      size="sm"
                      variant={activeTool === "move" ? "default" : "outline"}
                      onClick={() => setActiveTool(activeTool === "move" ? "none" : "move")}
                      className="flex flex-col gap-1 h-auto py-3"
                    >
                      <Move className="w-4 h-4" />
                      <span className="text-xs">Move</span>
                    </Button>
                  </div>

                  <Button
                    size="sm"
                    variant="outline"
                    onClick={clearPage}
                    className="w-full text-red-600 hover:text-red-700 hover:bg-red-50"
                  >
                    <Eraser className="w-4 h-4 mr-2" />
                    Clear Page
                  </Button>

                  {selectedAnnotation && (
                    <div className="p-3 bg-blue-50 rounded-lg border border-blue-200">
                      <p className="text-sm font-medium text-blue-900 mb-2">Annotation Selected</p>
                      <Button size="sm" variant="destructive" onClick={deleteSelected} className="w-full">
                        <X className="w-4 h-4 mr-2" />
                        Delete Selected
                      </Button>
                    </div>
                  )}

                  {(activeTool === "ink" || activeTool === "text") && (
                    <div className="space-y-4 p-3 bg-gray-50 rounded-lg">
                      <div>
                        <Label className="text-sm font-medium">Color</Label>
                        <div className="grid grid-cols-3 gap-2 mt-2">
                          {colors.map((color) => (
                            <button
                              key={color.value}
                              className={cn(
                                "w-full h-8 rounded-md border-2 transition-all",
                                inkColor === color.value
                                  ? "border-gray-900 scale-110"
                                  : "border-gray-200 hover:border-gray-300",
                              )}
                              style={{ backgroundColor: color.value }}
                              onClick={() => setInkColor(color.value)}
                              title={color.name}
                            />
                          ))}
                        </div>
                      </div>

                      {activeTool === "ink" && (
                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <Label className="text-sm font-medium">Brush Size</Label>
                            <span className="text-sm text-gray-600">{inkWidth}px</span>
                          </div>
                          <Slider
                            value={[inkWidth]}
                            onValueChange={(value) => setInkWidth(value[0])}
                            max={12}
                            min={1}
                            step={1}
                            className="w-full"
                          />
                        </div>
                      )}
                    </div>
                  )}

                  {activeTool === "highlight" && (
                    <div className="space-y-4 p-3 bg-yellow-50 rounded-lg">
                      <div>
                        <Label className="text-sm font-medium">Highlight Color</Label>
                        <div className="grid grid-cols-3 gap-2 mt-2">
                          {highlightColors.map((color) => (
                            <button
                              key={color.value}
                              className={cn(
                                "w-full h-8 rounded-md border-2 transition-all",
                                highlightColor === color.value
                                  ? "border-gray-900 scale-110"
                                  : "border-gray-200 hover:border-gray-300",
                              )}
                              style={{ backgroundColor: color.value }}
                              onClick={() => setHighlightColor(color.value)}
                              title={color.name}
                            />
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                  {currentPageAnnotations.length > 0 && (
                    <div className="p-3 bg-green-50 rounded-lg border border-green-200">
                      <p className="text-sm font-medium text-green-900">
                        {currentPageAnnotations.length} annotation{currentPageAnnotations.length !== 1 ? "s" : ""} on
                        this page
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </aside>
          )}

          <main className="flex-1 overflow-auto bg-slate-100" ref={containerRef}>
            {isLoading ? (
              <div className="flex items-center justify-center h-full">
                <div className="text-center space-y-4">
                  <div className="animate-spin rounded-full h-12 w-12 border-4 border-blue-600 border-t-transparent mx-auto"></div>
                  <div>
                    <p className="font-medium">Loading PDF...</p>
                    <p className="text-sm text-gray-500">Please wait while we process your document</p>
                  </div>
                </div>
              </div>
            ) : pdfDoc ? (
              <div className={cn("p-4 md:p-6", isFullscreen && "pt-20")}>
                <Card className="mx-auto w-fit shadow-lg bg-white p-4">
                  <div className="relative">
                    <canvas ref={canvasRef} className="block max-w-full h-auto" />
                    <canvas ref={annotationCanvasRef} className={cn("absolute top-0 left-0 pointer-events-none")} />
                    <canvas ref={tempCanvasRef} className={cn("absolute top-0 left-0 pointer-events-none")} />
                    <div
                      className={cn(
                        "absolute top-0 left-0 w-full h-full",
                        activeTool === "move"
                          ? "cursor-move"
                          : activeTool === "highlight"
                            ? "cursor-cell"
                            : activeTool !== "none"
                              ? "cursor-crosshair"
                              : "cursor-default",
                      )}
                      onMouseDown={startDrawing}
                      onMouseMove={continueDrawing}
                      onMouseUp={stopDrawing}
                      onMouseLeave={stopDrawing}
                      onTouchStart={startDrawing}
                      onTouchMove={continueDrawing}
                      onTouchEnd={stopDrawing}
                    />
                  </div>
                </Card>
              </div>
            ) : (
              <div className="flex items-center justify-center h-full">
                <div className="text-center space-y-6 max-w-md mx-auto px-4">
                  <div className="w-24 h-24 mx-auto bg-blue-100 rounded-full flex items-center justify-center">
                    <FileText className="w-12 h-12 text-blue-600" />
                  </div>
                  <div>
                    <h2 className="text-xl font-semibold text-gray-900 mb-2">No PDF loaded</h2>
                    <p className="text-gray-500 mb-6">
                      {!pdfJsLoaded
                        ? "Loading PDF.js library..."
                        : "Upload a PDF document to start viewing and annotating"}
                    </p>
                    <Button onClick={() => fileInputRef.current?.click()} size="lg" disabled={!pdfJsLoaded}>
                      <Upload className="w-4 h-4 mr-2" />
                      Choose PDF File
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </main>
        </div>

        {sidebarOpen && !isFullscreen && pdfDoc && (
          <div className="md:hidden fixed inset-0 bg-black bg-opacity-50 z-30" onClick={() => setSidebarOpen(false)} />
        )}

        <input ref={fileInputRef} type="file" accept=".pdf" onChange={handleFileUpload} className="hidden" />

        {/* Username Dialog for Screenshot */}
        <Dialog open={userNameDialog.open} onOpenChange={(open) => setUserNameDialog({ open })}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Take Screenshot</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label htmlFor="username">Your Name (for watermark)</Label>
                <Input
                  id="username"
                  placeholder="Enter your name..."
                  value={userName}
                  onChange={(e) => setUserName(e.target.value)}
                  autoFocus
                />
              </div>
              <p className="text-sm text-gray-500">
                This will capture the current page with all annotations and add your name as a watermark.
              </p>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setUserNameDialog({ open: false })}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  setUserNameDialog({ open: false })
                  takeScreenshot()
                }}
                disabled={!userName.trim()}
              >
                <Camera className="w-4 h-4 mr-2" />
                Take Screenshot
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Text Annotation Dialog */}
        <Dialog open={textDialog.open} onOpenChange={(open) => setTextDialog((prev) => ({ ...prev, open }))}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Add Text Annotation</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label htmlFor="annotation-text">Text</Label>
                <Textarea
                  id="annotation-text"
                  placeholder="Enter your annotation text..."
                  value={textDialog.text}
                  onChange={(e) => setTextDialog((prev) => ({ ...prev, text: e.target.value }))}
                  className="min-h-[100px]"
                  autoFocus
                />
              </div>
              <div className="flex items-center gap-2">
                <Label className="text-sm">Color:</Label>
                <div className="flex gap-1">
                  {colors.slice(0, 4).map((color) => (
                    <button
                      key={color.value}
                      className={cn(
                        "w-6 h-6 rounded border-2 transition-all hover:scale-110",
                        inkColor === color.value ? "border-gray-900 scale-110" : "border-gray-200",
                      )}
                      style={{ backgroundColor: color.value }}
                      onClick={() => setInkColor(color.value)}
                      title={color.name}
                    />
                  ))}
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setTextDialog({ open: false, x: 0, y: 0, text: "" })}>
                Cancel
              </Button>
              <Button onClick={handleTextSubmit} disabled={!textDialog.text.trim()}>
                Add Annotation
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  )
}
