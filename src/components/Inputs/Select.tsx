/*
Copyright 2018 - 2022 The Alephium Authors
This file is part of the alephium project.

The library is free software: you can redistribute it and/or modify
it under the terms of the GNU Lesser General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

The library is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Lesser General Public License for more details.

You should have received a copy of the GNU Lesser General Public License
along with the library. If not, see <http://www.gnu.org/licenses/>.
*/

import { isEqual } from 'lodash'
import { MoreVertical } from 'lucide-react'
import { MouseEvent, OptionHTMLAttributes, useCallback, useEffect, useState } from 'react'
import styled from 'styled-components'

import { InputLabel, InputProps } from '@/components/Inputs'
import InputArea from '@/components/Inputs/InputArea'
import { sectionChildrenVariants } from '@/components/PageComponents/PageContainers'
import Popup from '@/components/Popup'
import ModalPortal from '@/modals/ModalPortal'
import { Coordinates } from '@/types/numbers'

import { InputBase } from './Input'

type Writable<T> = T extends string
  ? string
  : T extends number
  ? number
  : T extends undefined
  ? undefined
  : T extends readonly (infer U)[]
  ? U
  : never

export type OptionValue = Writable<OptionHTMLAttributes<HTMLOptionElement>['value']>

export interface SelectOption<T extends OptionValue> {
  value: T
  label: string
}

interface SelectProps<T extends OptionValue> {
  label?: string
  disabled?: boolean
  controlledValue?: SelectOption<T>
  options: SelectOption<T>[]
  title?: string
  id: string
  onValueChange: (value: SelectOption<T> | undefined) => void
  raised?: boolean
  skipEqualityCheck?: boolean
  noMargin?: boolean
  className?: string
}

function Select<T extends OptionValue>({
  options,
  title,
  label,
  disabled,
  controlledValue,
  id,
  onValueChange,
  raised,
  skipEqualityCheck = false,
  noMargin,
  className
}: SelectProps<T>) {
  const [canBeAnimated, setCanBeAnimated] = useState(false)
  const [value, setValue] = useState(controlledValue)
  const [showPopup, setShowPopup] = useState(false)
  const [mousePosition, setMousePosition] = useState<Coordinates | undefined>(undefined)

  const setInputValue = useCallback(
    (option: SelectOption<T>) => {
      if (!value || !isEqual(option, value) || skipEqualityCheck) {
        onValueChange(option)
        setValue(option)
      }
    },
    [onValueChange, skipEqualityCheck, value]
  )

  const handleClick = (e: MouseEvent) => {
    if (options.length <= 1) return

    setMousePosition({ x: e.clientX, y: e.clientY })
    setShowPopup(true)
  }

  useEffect(() => {
    // Controlled component
    if (controlledValue && (!isEqual(controlledValue, value) || skipEqualityCheck)) {
      setValue(controlledValue)
    }
  }, [controlledValue, setInputValue, skipEqualityCheck, value])

  useEffect(() => {
    // If only one value, select it
    if (!value && options.length === 1) {
      setInputValue(options[0])
    }
  }, [options, setInputValue, value])

  useEffect(() => {
    if (value && !options.find((option) => option.value === value.value)) {
      setValue(undefined)
    }
  }, [options, value])

  return (
    <>
      <SelectContainer
        variants={sectionChildrenVariants}
        animate={canBeAnimated ? (!disabled ? 'shown' : 'disabled') : false}
        onAnimationComplete={() => setCanBeAnimated(true)}
        custom={disabled}
        noMargin={noMargin}
        onMouseDown={handleClick}
        style={{ zIndex: raised && showPopup ? 2 : undefined }}
      >
        <InputLabel inputHasValue={!!value} htmlFor={id}>
          {label}
        </InputLabel>
        {options.length > 1 && (
          <MoreIcon>
            <MoreVertical />
          </MoreIcon>
        )}
        <ClickableInput
          type="text"
          tabIndex={-1}
          className={className}
          disabled={disabled}
          id={id}
          value={value?.label ?? ''}
          readOnly
          label={label}
        />
      </SelectContainer>
      <ModalPortal>
        {showPopup && (
          <SelectOptionsPopup
            options={options}
            setValue={setInputValue}
            title={title}
            mousePosition={mousePosition}
            onBackgroundClick={() => {
              setShowPopup(false)
            }}
          />
        )}
      </ModalPortal>
    </>
  )
}

function SelectOptionsPopup<T extends OptionValue>({
  options,
  setValue,
  onBackgroundClick,
  mousePosition,
  title
}: {
  options: SelectOption<T>[]
  setValue: (value: SelectOption<T>) => void | undefined
  onBackgroundClick: () => void
  mousePosition?: Coordinates
  title?: string
}) {
  const handleEvent = (el: HTMLSelectElement) =>
    handleOptionSelect({
      label: options[el.selectedIndex]?.label,
      value: el.value as T
    })

  const handleOptionSelect = (option: SelectOption<T>) => {
    setValue(option)
    onBackgroundClick()
  }

  return (
    <Popup title={title} onBackgroundClick={onBackgroundClick} hookCoordinates={mousePosition}>
      <OptionSelect autoFocus size={options.length} onKeyPress={(e) => handleEvent(e.currentTarget)}>
        {options.map((o) => (
          <OptionItem key={o.label} value={o.value} onClick={() => handleOptionSelect(o)}>
            {o.label}
          </OptionItem>
        ))}
      </OptionSelect>
    </Popup>
  )
}

export default Select

const InputContainer = styled(InputArea)`
  position: relative;
  height: var(--inputHeight);
  width: 100%;
  margin: 16px 0;
  padding: 0;
`

export const MoreIcon = styled.div`
  position: absolute;
  top: 14px;
  right: 10px;
  color: ${({ theme }) => theme.font.secondary};
`

export const SelectContainer = styled(InputContainer)<Pick<InputProps, 'noMargin'>>`
  cursor: pointer;
  margin: ${({ noMargin }) => (noMargin ? 0 : '16px 0')};
`

export const OptionSelect = styled.select`
  width: 100%;
  overflow-y: auto;
  border: 0;
  outline: 0;
  color: inherit;
  background: transparent;
`

export const OptionItem = styled.option`
  padding: var(--spacing-4);
  cursor: pointer;
  background-color: ${({ theme }) => theme.bg.primary};
  color: inherit;
  user-select: none;

  &:not(:last-child) {
    border-bottom: 1px solid ${({ theme }) => theme.border.primary};
  }

  &:hover {
    background-color: ${({ theme }) => theme.bg.secondary};
  }
`

const ClickableInput = styled(InputBase)`
  padding-right: 35px;
  font-weight: var(--fontWeight-semiBold);
  cursor: pointer;
`
